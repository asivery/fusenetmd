import { Mutex } from "async-mutex";
import { Disc, getTracks, Encoding } from "netmd-js";

export async function synchronized<T>(mutex: Mutex, func: () => T | Promise<T>): Promise<T> {
    let release = await mutex.acquire();
    let ret = func();
    if(ret instanceof Promise){
        ret = await ret;
    }
    release();
    return ret;
}

export function shallowCompareArrays<T>(a: T[], b: T[]){
    if(a.length !== b.length) return false;
    for(let i = 0; i<a.length; i++){
        if(a[i] !== b[i]) return false;
    }
    return true;
}

export function asyncMutex(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    // This is meant to be used only with classes having a "mutex" instance property
    const oldValue = descriptor.value;
    descriptor.value = async function(...args: any) {
        const mutex = (this as any).mutex as Mutex;
        const release = await mutex.acquire();
        try {
            return await oldValue.apply(this, args);
        } finally {
            release();
        }
    };
    return descriptor;
}

export function getValidNameTracks(disc: Disc){
    return getTracks(disc)
        .filter(n => !n.title?.startsWith("h_fs_"))
        .map(n => ({ index: n.index, name: `${n.index + 1}. ${(n.title || "No Title")?.replace("/", "_")}.${n.encoding === Encoding.sp ? "aea" : "wav"}` }));
}