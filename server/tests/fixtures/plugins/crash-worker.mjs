// A sandbox worker that dies at once, as a wasm abort would.
throw new Error(`Aborted(Assertion failed) at ${import.meta.url.replace("file://", "")}:3:7\n    at JS_FreeRuntime (quickjs.c:2036)`);
