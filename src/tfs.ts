import { FSDirectory, FSFile } from "./filesystem";
import { concatUint8Arrays } from "netmd-js/dist/utils";
import { shallowCompareArrays } from "./utils";
import { TransferManager } from "./transfer";

/*
TFS General Rules

Every file is stored as a separate track (transferred via LP, forced to SP, F_WRITABLE unset) on disc
Every file's name follows the format: _fs_{file number padded to 3 sigits}

TFS consists of chained records, one after another. In the case of directories, they are following a tree-like structure
TFS' 'FILE' record:
[00|01|02|03] [file number (byte)] [bytes count (00 -> byte, 01 -> 2byte...)] [file name terminated with \0]

TFS' 'DIR' record
[F0] [UTF-8 dir name terminated with \0] [subsequent file / dir records] [FF]

Every TFS system has to start with '8cb396e98da2' (magic number)
*/

const MAGIC = new Uint8Array([0x8c, 0xb3, 0x96, 0xe9, 0x8d, 0xa2]);

export function createTFSStructure(root: FSDirectory): Uint8Array{
    const encoder = new TextEncoder();

    let outputSlices: Uint8Array[] = [];
    outputSlices.push(MAGIC);
    
    function writeFile(file: FSFile){
        let type = 0;
        if(file.byteLength > 0xffffff) type = 3;
        else if(file.byteLength > 0xffff) type = 2;
        else if(file.byteLength > 0xff) type = 1;

        let bytes = [];
        for(let i = type; i>=0; i--){
            bytes.push((file.byteLength >> (8*i)) & 0xff);
        }

        outputSlices.push(new Uint8Array([
            type,
            file.trackID,
            ...bytes,
        ]));
        outputSlices.push(encoder.encode(file.name));
        outputSlices.push(new Uint8Array([0x00]));
    }

    function enumerateDir(dir: FSDirectory){
        // isRoot skips writing the initial dir record
        outputSlices.push(new Uint8Array([0xf0]));
        outputSlices.push(encoder.encode(dir.name));
        outputSlices.push(new Uint8Array([0x00]));
        for(let fileName of Object.keys(dir.files)){
            let file = dir.files[fileName];
            if(file instanceof FSFile){
                writeFile(file);
            }else if(file instanceof FSDirectory){
                enumerateDir(file);
            }
        }
        outputSlices.push(new Uint8Array([0xff]));
    }
    enumerateDir(root);
    const sum = concatUint8Arrays(...outputSlices);
    if(sum.length > 2300) throw new Error("TFS overflow");
    return sum;
}

export function parseTFSStructure(raw: Uint8Array, transferManager: TransferManager): FSDirectory{
    const decoder = new TextDecoder();
    const rawArr = Array.from(raw);
    const next = (e: number) => rawArr.splice(0, e);
    
    let magicPart = next(MAGIC.length);
    if(!shallowCompareArrays(magicPart, Array.from(MAGIC))){
        throw new Error("Wrong MAGIC");
    }
    function getText(){
        let length = rawArr.indexOf(0);
        let text = decoder.decode(new Uint8Array(next(length)));
        next(1);
        return text;
    }
    if(next(1)[0] !== 0xf0) throw new Error("Illegal root dir record");

    function tranverseDirectory(){
        let name = getText();
        let files = [];
        while(rawArr[0] !== 0xff){
            let type = next(1)[0];
            if(type >= 0 && type <= 3){
                // File
                let trackID = next(1)[0];
                let lengthBytes = next(1 + type);
                let length = 0;
                for(let b of lengthBytes){
                    length <<= 8;
                    length += b;
                }
                let name = getText();
                files.push(new FSFile(trackID, name, length, transferManager));
            } else if(type === 0xf0){
                let dir = tranverseDirectory();
                files.push(dir);
            }
        }
        next(1);
        let dir = new FSDirectory(name);
        files.forEach(n => dir.add(n));
        return dir;
    }
    return tranverseDirectory();
}
