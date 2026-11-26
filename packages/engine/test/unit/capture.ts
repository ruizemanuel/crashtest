export interface Capture {
  text(): string;
  restore(): void;
}

function capture(stream: NodeJS.WriteStream): Capture {
  const original = stream.write;
  let buffer = "";
  stream.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write;
  return {
    text: () => buffer,
    restore: () => {
      stream.write = original;
    },
  };
}

export function captureStdout(): Capture {
  return capture(process.stdout);
}

export function captureStderr(): Capture {
  return capture(process.stderr);
}
