import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/app.js";

const app = buildApp();
const ready = app.ready();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await ready;
  app.server.emit("request", req, res);
}
