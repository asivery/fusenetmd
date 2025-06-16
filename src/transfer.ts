import { FSFile, FSDirectory, Cache } from "./filesystem";
import { Mutex } from "async-mutex";
import { Worker } from 'worker_threads';
import { synchronized, asyncMutex } from "./utils";
import { NetMDInterface, DiscFormat, listContent, writeUTOCSector, NetMDFactoryInterface, readUTOCSector, MDTrack, Wireformat, download } from "netmd-js";
import { makeGetAsyncPacketIteratorOnWorkerThread } from 'netmd-js/dist/node-encrypt-worker';
import { ExploitStateManager, AtracRecovery, ForceTOCEdit, getBestSuited, AtracRecoveryConfig } from 'netmd-exploits';
import { ToC, reconstructTOC, getTitleByTrackNumber, ModeFlag, parseTOC } from 'netmd-tocmanip';
import { createTFSStructure, parseTFSStructure } from "./tfs";
import path from 'path';
import { concatUint8Arrays } from "netmd-js/dist/utils";

export interface QueueEntry {
    target: FSFile;
    trackID: number;
}

const OFFSET = 0x2f + 1 + 255;
export type ReadTransferParams = {
    audioTrack: boolean;
};

export class TransferManager {
    private factoryIface: NetMDFactoryInterface | null = null;
    private exploitManager: ExploitStateManager | null = null;
    private cache?: Cache;

    private mutex = new Mutex();

    constructor(private netmd: NetMDInterface){}
    async init(cache: Cache){
        this.cache = cache;
        this.factoryIface = await this.netmd.factory();
        this.exploitManager = await ExploitStateManager.create(this.netmd, this.factoryIface);
    }

    @asyncMutex
    async startReadTransfer(target: FSFile, trackID: number, opts?: ReadTransferParams){
        const recovery = await this.exploitManager?.require(getBestSuited(AtracRecovery, this.exploitManager.device)!);
        let trackIndex;
        let options = {} as AtracRecoveryConfig;

        if(opts?.audioTrack){
            trackIndex = trackID;
        }else{
            trackIndex = this.cache!.resolveIDToIndex(trackID);
            options.removeLPBytes = 'always';
            options.writeHeader = false;
        }
        console.log(`Reading ${trackIndex}`);
        for await(let chunk of recovery!.downloadTrackGenerator(
            trackIndex,
            data => console.log(JSON.stringify(data)),
            options
        )){
            if(chunk.type == 'audioData' || (opts?.audioTrack && chunk.type == 'header')) {
                await target.append(chunk.chunk!);
            }
        }
        await target.markAsComplete();

    }

    async startFileWriteTransfer(id: number, data: Uint8Array){
        if(data.length < 2112){
            data = concatUint8Arrays(data, new Uint8Array(2112 - data.length));
        }
        console.log(`Transferring h_fs_${id.toString(16).padStart(2, '0')} (${data.length} bytes)`);
        await this.startAudioWriteTransfer(`h_fs_${id.toString(16).padStart(2, '0')}`, Wireformat.lp2, data);
    }

    @asyncMutex
    async deleteTrack(index: number){
        await this.netmd.eraseTrack(index);
        await this.cache?.refreshCache();
    }

    @asyncMutex
    async startAudioWriteTransfer(name: string, format: Wireformat, rawData: Uint8Array){
        const getAsyncPacketIteratorOnWorkerThread = makeGetAsyncPacketIteratorOnWorkerThread(
            new Worker(path.join(__dirname, "..", "node_modules", "netmd-js", "dist", 'node-encrypt-worker.js'))
        );
        let mdTrack = new MDTrack(name, format, rawData.buffer, 0x400, '', getAsyncPacketIteratorOnWorkerThread);
        await download(this.netmd, mdTrack, data => console.log(JSON.stringify(data)));
    }

    @asyncMutex
    async getDiscState(){ return await listContent(this.netmd); }

    @asyncMutex
    async getTFS(){
        let root;
        try{
            root = parseTFSStructure((await readUTOCSector(this.factoryIface!, 2)).slice(OFFSET), this);
        }catch(er){
            console.log(er);
            root = new FSDirectory("");
            console.log("Treating as an unformatted system and formatting as TFS!");
        }
        return root;
    }

    @asyncMutex
    async getTOC(){
        return parseTOC(
            await readUTOCSector(this.factoryIface!, 0),
            await readUTOCSector(this.factoryIface!, 1),
        );
    }

    @asyncMutex
    async writeTOC(root: FSDirectory){
        let toc = parseTOC(
            await readUTOCSector(this.factoryIface!, 0),
            await readUTOCSector(this.factoryIface!, 1),
        );
        for(let i = 0; i<toc.nTracks; i++){
            let name = getTitleByTrackNumber(toc, i+1);
            if(name.startsWith("h_fs_")){
                let link = toc.trackMap[i + 1];
                while(link !== 0){
                    let fragment = toc.trackFragmentList[link]
                    fragment.mode |= ModeFlag.F_SP_MODE | ModeFlag.F_STEREO;
                    fragment.mode &=~ModeFlag.F_WRITABLE;

                    link = fragment.link;
                }
            }
        }
        const sectors = reconstructTOC(toc);
        const tfs = Array.from(createTFSStructure(root));
        const padding = Array(2352 - tfs.length - OFFSET).fill(0);
        sectors[2] = new Uint8Array([
            ...Array(OFFSET).fill(0x00),
            ...tfs,
            ...padding,
        ]);

        for(let i = 0; i<sectors.length; i++){
            let sector = sectors[i];
            if(!sector) continue;
            await writeUTOCSector(this.factoryIface!, i, sector);
        }
        await (await this.exploitManager!.require(ForceTOCEdit)).forceTOCEdit();
    }
}
