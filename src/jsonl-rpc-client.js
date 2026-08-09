import { EventEmitter } from "node:events";

const DEFAULT_FRAME_LIMIT = 16 * 1024 * 1024;
const DEFAULT_QUEUE_LIMIT = 4 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRpcId(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function classifyEnvelope(message) {
  if (!isRecord(message)) throw new Error("RPC frame must be a JSON object");

  const hasId = Object.hasOwn(message, "id");
  const hasMethod = Object.hasOwn(message, "method");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");

  if (hasResult || hasError) {
    if (!hasId || !isRpcId(message.id) || hasMethod || hasResult === hasError) {
      throw new Error("Invalid RPC response envelope");
    }
    if (hasError && (!isRecord(message.error)
      || !Number.isFinite(message.error.code)
      || typeof message.error.message !== "string")) {
      throw new Error("Invalid RPC error envelope");
    }
    return "response";
  }

  if (hasMethod) {
    if (typeof message.method !== "string") throw new Error("Invalid RPC method");
    if (!hasId) return "notification";
    if (!isRpcId(message.id)) throw new Error("Invalid RPC request id");
    return "serverRequest";
  }

  throw new Error("Invalid RPC envelope");
}

export class RpcRemoteError extends Error {
  constructor(remoteError) {
    super(remoteError.message);
    this.name = "RpcRemoteError";
    this.code = remoteError.code;
    this.data = remoteError.data;
  }
}

export class RpcTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
    this.code = "RPC_TIMEOUT";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class JsonlRpcClient extends EventEmitter {
  #blocked = false;
  #writing = false;
  #writeTimer = null;
  #writeTimeoutMs;

  #onInputData = (chunk) => this.#consume(chunk);
  #onInputEnd = () => this.close(new Error("Codex App Server closed stdout"));
  #onInputError = (error) => this.close(error);
  #onInputClose = () => this.close(new Error("RPC input closed"));
  #onOutputDrain = () => this.#handleDrain();
  #onOutputError = (error) => this.close(error);
  #onOutputClose = () => this.close(new Error("RPC output closed"));

  constructor({
    input,
    output,
    timeoutMs = 15000,
    maxFrameBytes = DEFAULT_FRAME_LIMIT,
    maxQueuedBytes = DEFAULT_QUEUE_LIMIT,
    writeTimeoutMs = 15000,
  }) {
    super();
    this.input = input;
    this.output = output;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.maxQueuedBytes = maxQueuedBytes;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.outbox = [];
    this.queuedBytes = 0;
    this.closed = false;
    this.closeError = null;
    this.#writeTimeoutMs = writeTimeoutMs;

    input.setEncoding?.("utf8");
    input.on?.("data", this.#onInputData);
    input.on?.("end", this.#onInputEnd);
    input.on?.("error", this.#onInputError);
    input.on?.("close", this.#onInputClose);
    output.on?.("drain", this.#onOutputDrain);
    output.on?.("error", this.#onOutputError);
    output.on?.("close", this.#onOutputClose);
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(this.closeError);

    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer: null, method, timeoutMs });
    });

    try {
      this.#send({ method, id, params }, () => this.#startResponseTimer(id));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    return promise;
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  respondError(id, code, message) {
    this.#send({ id, error: { code, message } });
  }

  #send(message, onWritten) {
    if (this.closed) throw this.closeError;
    const frame = `${JSON.stringify(message)}\n`;
    const item = { frame, bytes: Buffer.byteLength(frame), onWritten };

    if (this.#blocked || this.#writing || this.outbox.length > 0) {
      this.#enqueue(item);
      return;
    }

    this.#write(item);
    this.#flushOutbox();
  }

  #enqueue(item) {
    if (this.queuedBytes + item.bytes > this.maxQueuedBytes) {
      const error = new Error(`RPC output queue exceeds ${this.maxQueuedBytes} bytes`);
      this.close(error);
      throw error;
    }
    this.outbox.push(item);
    this.queuedBytes += item.bytes;
  }

  #write(item) {
    let accepted;
    this.#writing = true;
    try {
      accepted = this.output.write(item.frame);
    } catch (error) {
      this.#writing = false;
      this.close(error);
      throw error;
    }
    this.#writing = false;
    item.onWritten?.();
    if (!accepted && !this.closed) {
      this.#blocked = true;
      this.#startWriteTimer();
    }
  }

  #flushOutbox() {
    while (!this.closed && !this.#blocked && !this.#writing && this.outbox.length > 0) {
      const item = this.outbox.shift();
      this.queuedBytes -= item.bytes;
      this.#write(item);
    }
  }

  #startResponseTimer(id) {
    const pending = this.pending.get(id);
    if (!pending || pending.timer) return;
    pending.timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      pending.reject(new RpcTimeoutError(pending.method, pending.timeoutMs));
    }, pending.timeoutMs);
  }

  #startWriteTimer() {
    clearTimeout(this.#writeTimer);
    this.#writeTimer = setTimeout(() => {
      this.close(new Error(`RPC output drain timed out after ${this.#writeTimeoutMs}ms`));
    }, this.#writeTimeoutMs);
  }

  #handleDrain() {
    if (this.closed || !this.#blocked) return;
    clearTimeout(this.#writeTimer);
    this.#writeTimer = null;
    this.#blocked = false;
    this.#flushOutbox();
  }

  #consume(chunk) {
    if (this.closed) return;
    this.buffer += String(chunk);

    for (;;) {
      if (this.closed) return;
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
          this.close(new Error(`RPC frame exceeds ${this.maxFrameBytes} bytes`));
        }
        return;
      }

      const rawLine = this.buffer.slice(0, newline);
      if (Buffer.byteLength(rawLine) > this.maxFrameBytes) {
        this.close(new Error(`RPC frame exceeds ${this.maxFrameBytes} bytes`));
        return;
      }
      this.buffer = this.buffer.slice(newline + 1);
      const line = rawLine.trim();
      if (!line) continue;

      let message;
      let type;
      try {
        message = JSON.parse(line);
        type = classifyEnvelope(message);
      } catch (error) {
        this.emit("protocolError", error, line);
        continue;
      }

      if (type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (Object.hasOwn(message, "error")) pending.reject(new RpcRemoteError(message.error));
        else pending.resolve(message.result);
      } else if (type === "serverRequest") {
        this.emit("serverRequest", message);
      } else {
        this.emit("notification", message);
      }
    }
  }

  close(error = new Error("RPC client closed")) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;

    this.#removeListener(this.input, "data", this.#onInputData);
    this.#removeListener(this.input, "end", this.#onInputEnd);
    this.#removeListener(this.input, "error", this.#onInputError);
    this.#removeListener(this.input, "close", this.#onInputClose);
    this.#removeListener(this.output, "drain", this.#onOutputDrain);
    this.#removeListener(this.output, "error", this.#onOutputError);
    this.#removeListener(this.output, "close", this.#onOutputClose);

    clearTimeout(this.#writeTimer);
    this.#writeTimer = null;
    this.#blocked = false;
    this.#writing = false;
    this.buffer = "";
    this.outbox.length = 0;
    this.queuedBytes = 0;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #removeListener(stream, event, listener) {
    if (typeof stream?.off === "function") stream.off(event, listener);
    else stream?.removeListener?.(event, listener);
  }
}
