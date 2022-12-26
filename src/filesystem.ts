import { Disc, getTracks } from "netmd-js";
import { concatUint8Arrays } from "netmd-js/dist/utils";
import { TransferManager, ReadTransferParams } from "./transfer";
import { Mutex } from 'async-mutex';
import { synchronized, asyncMutex } from "./utils";
import { discAddressToLogical, ModeFlag } from "netmd-tocmanip";

export class Cache {
    disc?: Disc;
    trackSectorLengths: number[] = [];
    audioFileCache: FSFile[] = [];
    filesystem: FSDirectory = new FSDirectory("");
    nextFileID: number = 0;

    constructor(private transferManager: TransferManager){}

    async init(){
        this.filesystem = await this.transferManager.getTFS();
    }

    async refreshCache(){
        this.disc = await this.transferManager.getDiscState();
        let taken = getTracks(this.disc)
            .filter(n => n.title?.startsWith("h_fs_"))
            .map(n => parseInt(n.title!.slice(5), 16));
        this.nextFileID = 0;
        while(taken.includes(this.nextFileID) ) this.nextFileID++;
        if(this.nextFileID > 0xff){
            console.log("ERROR - Too many files!!");
        }

        let toc = await this.transferManager.getTOC();
        this.trackSectorLengths = [];
        for(let i = 0; i<toc.nTracks; i++){
            let sectorCount = 0;
            let link = toc.trackMap[i + 1];
            let isLP = (toc.trackFragmentList[link].mode & ModeFlag.F_SP_MODE) === 0;
            while(link !== 0){
                let fragment = toc.trackFragmentList[link];
                let logicalEnd = discAddressToLogical(fragment.end);
                let logicalStart = discAddressToLogical(fragment.start);
                sectorCount += logicalEnd - logicalStart;
                link = fragment.link;
            }
            this.trackSectorLengths[i] = sectorCount * (2332 - (isLP ? (20 * 11) : 0)) + (isLP ? 48 : 2048);
        }
    }

    async flushCache(){
        await this.transferManager.writeTOC(this.filesystem);
        await this.refreshCache();
    }

    resolveIDToIndex(id: number) {
        let tracks = getTracks(this.disc!);
        console.log(`Resolving ${id}`);
        let matching = tracks.find(n => n.title === `h_fs_${id.toString(16).padStart(2, '0')}`);
        if(!matching) return -1;
        return matching.index;
    }
}

export interface WaitingRead {
    threshold: number;
    release: () => void;
}

export class FSFile {
    trackID: number;
    name: string;
    contents: Uint8Array | null = null;
    complete: boolean = false;
    byteLength: number;
    transferManager: TransferManager;
    readOpts?: ReadTransferParams;

    currentWaiting: WaitingRead[] = [];

    private mutex = new Mutex();

    constructor(trackID: number, name: string, byteLength: number, transferManager: TransferManager, readOpts?: ReadTransferParams){
        this.trackID = trackID;
        this.name = name;
        this.byteLength = byteLength;
        this.transferManager = transferManager;
        this.readOpts = readOpts;
    }
    
    @asyncMutex
    async append(contents: Uint8Array){
        this.contents = this.contents !== null ? concatUint8Arrays(this.contents, contents) : new Uint8Array(Array.from(contents));
        const length = this.contents.length;
        for(let i = this.currentWaiting.length - 1; i >= 0; i--){
            if(this.currentWaiting[i].threshold < length){
                this.currentWaiting.splice(i, 1)[0].release();
            }
        }
    }

    @asyncMutex
    async markAsComplete(){
        this.complete = true;
        for(let i = this.currentWaiting.length - 1; i >= 0; i--){ // release all.
            this.currentWaiting.splice(i, 1)[0].release();
        }
    }

    async getContents(start: number, length: number){
        let release = await this.mutex.acquire();
        let currentLength;
        if(!this.contents){
            currentLength = 0;
            this.transferManager.startReadTransfer(this, this.trackID, this.readOpts);
        }else{
            currentLength = this.contents!.length;
        }
        release();
        if(start + length > currentLength && !this.complete){
            await new Promise(async (release: any) => {
                synchronized(this.mutex, () => this.currentWaiting.push({ threshold: start + length, release }));
            });
        }
        let returnValue = synchronized(this.mutex, () => this.contents?.slice(start, start + length) || new Uint8Array([]));
        return returnValue;
    }
}

export class FSDirectory {
    files: { [key: string]: FSFile | FSDirectory } = {};
    name: string;

    constructor(name: string){
        this.name = name;
    }

    add(file: FSFile | FSDirectory){
        this.files[file.name] = file;
    }
    
    getFile(name: string): FSFile | FSDirectory | null{
        if(!Object.keys(this.files).includes(name)) return null;
        return this.files[name];
    }

    traverse(name: string): FSFile | FSDirectory | null {
        let current: FSDirectory = this;
        for(let dir of name.split("/")){
            if(dir === "") continue;
            let next = current.getFile(dir);
            if(next instanceof FSFile) return next;
            if(next === null) return null;
            current = next as FSDirectory;
        }
        return current;
    }
}
