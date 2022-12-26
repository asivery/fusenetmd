import { openNewDevice, NetMDInterface, Disc, DevicesIds } from 'netmd-js';
import { Mutex } from 'async-mutex';
import { mount, MountOptions, ENOENT, EACCES, EPERM, ENOTEMPTY } from 'fuse-bindings';
import { FSDirectory, FSFile, Cache } from './filesystem';
import { synchronized, getValidNameTracks } from './utils';
import { concatUint8Arrays } from 'netmd-js/dist/utils';
import { ToC } from 'netmd-tocmanip';
import { TransferManager } from './transfer';
import { WebUSB } from 'usb';
import { createTFSStructure, parseTFSStructure } from './tfs';

const S_IFDIR = 0o040000;
const S_IFREG = 0o0100000;
const EXEC_ACCESS = 0o111;
const WRITE_ACCESS = 0o222;
const READ_ACCESS = 0o444;

const RW_ACCESS = EXEC_ACCESS | WRITE_ACCESS | READ_ACCESS;

enum AvailableFunction {
    READ = READ_ACCESS,
    WRITE = WRITE_ACCESS,
}

interface SystemFile {
    write?: (content: Uint8Array) => Promise<void>;
    read?: () => Promise<Uint8Array>;
    available: AvailableFunction[];
}

interface FileHandle {
    close?: () => Promise<void>;
    read?: (offset: number, length: number) => Promise<Uint8Array>;
    write?: (offset: number, length: number, content: Uint8Array) => Promise<number>;
}

async function init(){
    const usb = new WebUSB({deviceTimeout: 100000, allowedDevices: DevicesIds});
    const dev = await openNewDevice(usb);
    if(!dev){
        console.log("There's no NetMD devices connected.");
        return;
    }
    const tra = new TransferManager(dev);
    const cah = new Cache(tra);
    await tra.init(cah);
    await cah.init();
    await cah.refreshCache();
    await prepareMount(tra, cah);
}

function getStat(stat: any){
    return {
        mtime: new Date(),
        atime: new Date(),
        ctime: new Date(),
        nlink: 1,
        uid: process.getuid ? process.getuid() : 0,
        gid: process.getgid ? process.getgid() : 0,
        ...stat,
    };
}

function getFileName(path: string){
    let fragments = path.split("/");
    return fragments[fragments.length - 1];
}


function fsFileToReadHandle(file: FSFile){
    let handle: FileHandle = {
        read: async (offset: number, length: number) => await file.getContents(offset, length),
    };
    return handle;
}

async function prepareMount(transferManager: TransferManager, cache: Cache){
    const systemFiles: {[key: string]: SystemFile} = {
        "info": {
            available: [ AvailableFunction.READ ],
            read: async () => {
                return new TextEncoder().encode(`
Please don't treat this software seriously...
(c) Copyright ${new Date().getFullYear()}, Asivery
                `);
            }
        },
        "handles": {
            available: [ AvailableFunction.READ ],
            read: async () => await synchronized(fileMutex, () => {
                let output = '';
                openFiles.forEach((n, i) => output += `${i}\t${n ? n.path : "<INVL>"}\n`);
                return new TextEncoder().encode(output);
            }),
        },
        "tfs.bin": {
            available: [AvailableFunction.READ, AvailableFunction.WRITE],
            read: async () => createTFSStructure(cache.filesystem),
            write: async(data) => {
                cache.filesystem = parseTFSStructure(data, transferManager);
            },
        },
        "force_immediate_flush": {
            available: [AvailableFunction.WRITE],
            write: async () => await cache.flushCache(),
        }
    }
    let fileMutex = new Mutex();
    let openFiles: ({handle: FileHandle, path: string} | null)[] = [];

    const addHandle = async (handle: FileHandle, path: string) => {
        return await synchronized(fileMutex, () => {
            let firstDeleted = openFiles.indexOf(null);
            if(firstDeleted === -1){
                openFiles.push({ handle, path });
                return openFiles.length - 1;
            }
            openFiles[firstDeleted] = { handle, path };
            return firstDeleted;
        });
    }
    const isValidHandle = async (fd: number) => await synchronized(fileMutex, () => openFiles.length > fd && openFiles[fd] !== null);
    const getHandle = async (fd: number) => await synchronized(fileMutex, () => openFiles[fd]!.handle);
    const invalidateHandle = async (fd: number) => await synchronized(fileMutex, () => openFiles[fd] = null);

    let createWhitelist: string[] = [];

    const callbacks: MountOptions = {
        readdir: (path: string, cb: (code: number, list: string[]) => void) => {
            console.log('readdir(%s)', path)
            if(path === '/'){
                cb(0, ['$audio', '$system', ...Object.keys(cache.filesystem.files)]);
                return;
            }else if(path === "/$system"){
                cb(0, Object.keys(systemFiles));
                return;
            }else if(path === "/$audio"){
                cb(0, getValidNameTracks(cache.disc!).map(n => n.name));
                return;
            }
            let file = cache.filesystem.traverse(path);
            if(file instanceof FSDirectory){
                cb(0, Object.keys(file.files));
                return;
            }
            cb(0, []);
        },
        getattr: async (path: string, cb: (code: number, stats?: any) => void) => {
            console.log('getattr(%s)', path)
            if(['/', '/$audio', '/$system'].includes(path)){
                cb(0, getStat({
                    mode: S_IFDIR | RW_ACCESS,
                    size: 1,
                }));
                return;
            }
            if(path.startsWith("/$system/")){
                let fileName = getFileName(path);
                let file = systemFiles[fileName];
                let accessMode = EXEC_ACCESS;
                file?.available.forEach(n => accessMode |= n);
                if(file){
                    cb(0, getStat({
                        mode: S_IFREG | accessMode,
                        size: file.available.includes(AvailableFunction.READ) ? (await file.read!()).length : 0,
                    }));
                }else{
                    cb(ENOENT);
                }
                return;
            }
            if(path.startsWith("/$audio/")){
                let fileName = getFileName(path);
                let allTracks = getValidNameTracks(cache.disc!);
                let thisTrack = allTracks.find(e => e.name === fileName);
                if(thisTrack){
                    let size = cache.trackSectorLengths[thisTrack.index];
                    cb(0, getStat({
                        mode: S_IFREG | EXEC_ACCESS | READ_ACCESS,
                        size
                    }));
                }else{
                    cb(ENOENT);
                }
                return;
            }
            if(await synchronized(fileMutex, () => createWhitelist.includes(path))){
                cb(0, getStat({
                    mode: S_IFREG | RW_ACCESS,
                    size: 0,
                }));
                return;
            }
            let file = cache.filesystem.traverse(path);

            if(file instanceof FSDirectory){
                cb(0, getStat({
                    mode: S_IFDIR | RW_ACCESS,
                    size: 1,
                }))
            }else if (file instanceof FSFile){
                cb(0, getStat({
                    mode: S_IFREG | RW_ACCESS,
                    size: file.byteLength,
                }));
            }else cb(ENOENT);
        },
        open: async (path: string, flags: number, cb: (code: number, fd: number) => void) => {
            console.log('open(%s, %d)', path, flags)
            flags = flags & 3;
            if(flags !== 0 && flags !== 1){
                cb(EACCES, 0); // Only normal read and normal write.
            }
            if(path.startsWith("/$system/")){
                let fileName = getFileName(path);
                let file = systemFiles[fileName];
                if(!file){
                    cb(ENOENT, 0);
                    return;
                }
                if((flags === 0 && !file.available.includes(AvailableFunction.READ)) || (flags === 1 && !file.available.includes(AvailableFunction.WRITE))){
                    cb(EACCES, 0);
                    return;
                }

                if(flags === 0) {
                    let contents = await file.read!();
                    let handle: FileHandle = {
                        read: async (offset: number, length: number) => contents.slice(offset, offset + length),
                    };
                    cb(0, await addHandle(handle, path));
                }else{
                    let buffer = new Uint8Array();
                    let handle: FileHandle = {
                        close: async () => {
                            await file.write!(buffer);
                        },
                        write: async (offset: number, length: number, data: Uint8Array) => {
                            let absoluteEnd = offset + data.length;
                            if(buffer.length < absoluteEnd){
                                buffer = concatUint8Arrays(
                                    buffer,
                                    new Uint8Array(Array(absoluteEnd - buffer.length))
                                );
                            }
                            for(let i = 0; i<length; i++){
                                buffer[i + offset] = data[i];
                            }
                            return data.length;
                        }
                    }
                    cb(0, await addHandle(handle, path));
                }
                return;
            }
            if(path.startsWith("/$audio/")){
                let fileName = getFileName(path);
                let allTracks = getValidNameTracks(cache.disc!);
                let thisTrack = allTracks.find(e => e.name === fileName);
                if(flags !== 0 && !thisTrack){
                    cb(EACCES, 0);
                    return;
                }
                if(flags !== 0){
                    cb(EACCES, 0);
                    return;
                }
                if(!thisTrack){
                    cb(ENOENT, 0);
                    return;
                }
                if(cache.audioFileCache[thisTrack.index]){
                    cb(0, await addHandle(fsFileToReadHandle(cache.audioFileCache[thisTrack.index]), path));
                    return;
                }
                let mockFile = new FSFile(thisTrack.index, fileName, -1, transferManager, { audioTrack: true });
                cache.audioFileCache[thisTrack.index] = mockFile;
                cb(0, await addHandle(fsFileToReadHandle(mockFile), path));
                return;
            }

            // Filesystem access
            if(flags === 0){
                // Read
                let existing = cache.filesystem.traverse(path);
                if(!(existing instanceof FSFile)){
                    cb(EPERM, 0);
                    return;
                }
                cb(0, await addHandle(fsFileToReadHandle(existing), path));
            }else{
                // Write
                let existing = cache.filesystem.traverse(path);
                let fileName = getFileName(path);
                let idToUse = cache.nextFileID;
                if(existing instanceof FSFile){
                    idToUse = existing.trackID;
                    if(existing.byteLength !== 0){
                        let trackIndex = cache.resolveIDToIndex(idToUse);
                        if(trackIndex === -1){
                            cb(EPERM, 0);
                            return;    
                        }
                        await transferManager.deleteTrack(trackIndex);
                    }
                }else if(existing instanceof FSDirectory){
                    cb(EPERM, 0);
                    return;
                }
                let cachedFile = new FSFile(idToUse, fileName, 0, transferManager);
                cachedFile.append(new Uint8Array());
                let parent = cache.filesystem.traverse(path.substring(0, path.length - fileName.length)) as FSDirectory;
                parent.add(cachedFile);
                const handle: FileHandle = {
                    close: async () => {
                        cachedFile.markAsComplete();
                        await synchronized(fileMutex, () => {
                            if(createWhitelist.includes(path)){
                                createWhitelist.splice(createWhitelist.indexOf(path), 1);
                            }
                        });
                        if(cachedFile.contents!.length !== 0){
                            await transferManager.startFileWriteTransfer(idToUse, cachedFile.contents!);
                            await cache.flushCache();
                        }
                    },
                    write: async (offset: number, length: number, data: Uint8Array) => {
                        // TODO: Un-duplicate this code from the system stuff
                        let absoluteEnd = offset + data.length;
                        if(cachedFile.contents!.length < absoluteEnd){
                            cachedFile.contents = concatUint8Arrays(
                                cachedFile.contents!,
                                new Uint8Array(Array(absoluteEnd - cachedFile.contents!.length))
                            );
                        }
                        for(let i = 0; i<length; i++){
                            cachedFile.contents![i + offset] = data[i];
                        }
                        cachedFile.byteLength = cachedFile.contents!.length;
                        console.log(`Wrote ${length} bytes`);
                        return length;
                    }
                }
                cb(0, await addHandle(handle, path));
            }
        },
        create: async (path: string, mode: number, cb: (code: number, fd: number) => void) => {
            console.log('create(%s, %d)', path, mode)
            if(path.startsWith("/$system/")){
                cb(EPERM, 0);
                return;
            }
            if(path.startsWith("/$audio/")){
                cb(EPERM, 0);
            }
            let idToUse = cache.nextFileID;
            let fileName = getFileName(path);
            let cachedFile = new FSFile(idToUse, fileName, 0, transferManager);
            cachedFile.append(new Uint8Array());
            let parent = cache.filesystem.traverse(path.substring(0, path.length - fileName.length)) as FSDirectory;
            parent.add(cachedFile);
            const handle: FileHandle = {
                close: async () => {
                    cachedFile.markAsComplete();
                    await synchronized(fileMutex, () => {
                        if(createWhitelist.includes(path)){
                            createWhitelist.splice(createWhitelist.indexOf(path), 1);
                        }
                    });
                    if(cachedFile.contents!.length !== 0){
                        await transferManager.startFileWriteTransfer(idToUse, cachedFile.contents!);
                        await cache.flushCache();
                    }
                },
                write: async (offset: number, length: number, data: Uint8Array) => {
                    // TODO: Un-duplicate this code from the system stuff
                    let absoluteEnd = offset + data.length;
                    if(cachedFile.contents!.length < absoluteEnd){
                        cachedFile.contents = concatUint8Arrays(
                            cachedFile.contents!,
                            new Uint8Array(Array(absoluteEnd - cachedFile.contents!.length))
                        );
                    }
                    for(let i = 0; i<length; i++){
                        cachedFile.contents![i + offset] = data[i];
                    }
                    cachedFile.byteLength = cachedFile.contents!.length;
                    console.log(`Wrote ${length} bytes`);
                    return length;
                },
            }
            cb(0, await addHandle(handle, path));
            return;
        },
        read: async (path: string, fd: number, buffer: Buffer, length: number, position: number, cb: (bytesReadOrErr: number) => void) => {
            console.log('read(%s, %d, %d, %d)', path, fd, length, position);
            if(!await isValidHandle(fd)){
                cb(EACCES);
                return;
            }
            const handle = await getHandle(fd);
            if(!handle.read){
                cb(EPERM);
                return;
            }
            const data = await handle.read!(position, length);
            for(let i = 0; i<data.length; i++){
                buffer[i] = data[i];
            }
            cb(data.length);
        },
        write: async (path: string, fd: number, buffer: Buffer, length: number, position: number, cb: (bytesWrittenOrErr: number) => void) => {
            console.log('write(%s, %d, %d, %d)', path, fd, length, position);
            if(!await isValidHandle(fd)){
                cb(EACCES);
                return;
            }
            const handle = await getHandle(fd);
            if(!handle.write){
                cb(EPERM);
                return;
            }
            cb(await handle.write(position, length, buffer));
        },
        truncate: (path: string, size: number, cb: (code: number) => void)=>cb(0),
        release: async (path: string, fd: number, cb: (code: number) => void) => {
            console.log('release(%s, %d)', path, fd);
            if(!await isValidHandle(fd)){
                cb(EACCES);
                return;
            }
            const handle = await getHandle(fd);
            if(handle.close) await handle.close();
            await invalidateHandle(fd);
            cb(0);
        },
        unlink: async (path: string, cb: (code: number) => void) => {
            console.log('release(%s)', path);
            if(path.startsWith("/$system")){
                cb(EPERM);
                return;
            }
            if(path.startsWith("/$audio/")){
                const fileName = getFileName(path);
                const allTracks = getValidNameTracks(cache.disc!);
                let thisTrack = allTracks.find(e => e.name === fileName);
                if(!thisTrack){
                    cb(ENOENT);
                    return;
                }
                await transferManager.deleteTrack(thisTrack.index);
                cb(0);
                return;
            }
            let file = cache.filesystem.traverse(path);
            if(!file){
                cb(ENOENT);
                return;
            }
            if(file instanceof FSDirectory){
                if(Object.keys(file.files).length !== 0){
                    cb(ENOTEMPTY);
                    return;
                }
            }
            let parent = cache.filesystem.traverse(path.substring(0, path.length - file.name.length)) as FSDirectory;
            delete parent.files[file.name];
            if(file instanceof FSFile){
                let trackIndex = cache.resolveIDToIndex(file.trackID);
                if(trackIndex === -1){
                    cb(ENOENT);
                    return;
                }
                await transferManager.deleteTrack(trackIndex);
            }
            cb(0);
            return;
        },
        mkdir: (path: string, mode: number, cb: (code: number) => void) => {
            let fileName = getFileName(path);
            let parentName = path.substring(0, path.length - fileName.length);
            let parent = cache.filesystem.traverse(parentName);
            let newDir = new FSDirectory(fileName);
            if(!(parent instanceof FSDirectory)){
                cb(EPERM);
                return;
            }
            parent.add(newDir);
            cb(0);
        },
        rename: (src: string, dest: string, cb: (code: number) => void) => {
            let file = cache.filesystem.traverse(src);
            if(!file){
                cb(ENOENT);
                return;
            }
            let parentName = src.substring(0, src.length - file.name.length);
            let parent = cache.filesystem.traverse(parentName);

            if(cache.filesystem.traverse(dest) || !(parent instanceof FSDirectory)){
                // Destination cannot exist
                cb(EPERM);
                return;
            }
            let destName = getFileName(dest);
            let destParentName = dest.substring(0, dest.length - destName.length);
            let destParent = cache.filesystem.traverse(destParentName);
            if(!(destParent instanceof FSDirectory)){
                cb(EPERM);
                return;
            }
            delete parent.files[file.name];
            file.name = destName;
            destParent.add(file);
            cb(0);
        },
        options: ['async_read']
    };

    mount("./mnt", callbacks, (e: any) => {
        if(e) console.log(e);
        else console.log("Mounted!")
    });
}

init();
