// A reader for `loopway read` and `loopway poll`: logs each message to $VERIFY_EVIDENCE/read.log, and throws on the type
// named in $VERIFY_EVIDENCE/fail-on, if that file exists.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const dir = process.env.VERIFY_EVIDENCE;

export default async function (msg) {
  const failOn = `${dir}/fail-on`;
  if (existsSync(failOn) && msg.type === readFileSync(failOn, "utf8").trim()) throw new Error("no thanks");
  appendFileSync(`${dir}/read.log`, `${msg.id} ${msg.type}\n`);
}
