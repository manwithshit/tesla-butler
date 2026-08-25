export function consumeLines(stream, onLine) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  });
  stream.on("end", () => {
    if (pending.trim()) onLine(pending);
  });
}
