#!/usr/bin/env node
// Deterministic one-shot CLI; never visits the supplied URL.
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args.includes("--version")) {
  console.log(`obscura ${process.env.OBSCURA_FAKE_VERSION ?? "0.2.3"}`);
} else if (args[0] !== "fetch") {
  console.error("Expected fetch");
  process.exitCode = 1;
} else {
  const url = new URL(args[1]);
  const format = option("--dump");
  if (option("--timeout") === "0" || url.hostname === "timeout.example") {
    process.exitCode = 124;
  } else if (url.hostname === "private-block.example") {
    console.error("Access to private/internal IP address 127.0.0.1 is not allowed");
    process.exitCode = 1;
  } else if (url.hostname === "hang.invalid") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else if (url.hostname === "hang.example") {
    setInterval(() => {}, 1000);
  } else if (url.hostname === "large.example") {
    console.log(`${format} ${url}\n${"x".repeat(20000)}\nEND`);
  } else if (url.hostname === "overflow.example") {
    process.stdout.write("x".repeat(9 * 1024 * 1024));
  } else if (url.hostname === "stderr-tail.example") {
    process.stderr.write(`DISCARDED_PREFIX${"x".repeat(5000)}LAST_DIAGNOSTIC`, () => { process.exitCode = 3; });
  } else if (url.hostname === "env.example") {
    console.log(JSON.stringify(process.env));
  } else {
    console.log(`${format} ${args[1]}`);
  }
}
