export function objectToUint8Array(obj) {
    if (obj instanceof Uint8Array)
        return obj;
    if (Array.isArray(obj))
        return new Uint8Array(obj);
    const keys = Object.keys(obj).map(k => parseInt(k)).sort((a, b) => a - b);
    return new Uint8Array(keys.map(k => obj[k]));
}
