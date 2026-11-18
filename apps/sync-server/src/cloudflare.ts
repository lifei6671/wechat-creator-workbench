import { createApp } from "./app.js";
import { d1Database, type D1Binding } from "./adapters/d1.js";
import { r2Blobs, type R2Binding } from "./adapters/r2.js";

interface Env {
  DB: D1Binding;
  BLOBS: R2Binding;
  SETUP_SECRET?: string;
}

export default {
  fetch(request: Request, env: Env) {
    return createApp(d1Database(env.DB), r2Blobs(env.BLOBS), env.SETUP_SECRET).fetch(request);
  },
};
