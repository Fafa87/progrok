// Imported first by src/index.ts so the warning prints before anything else
// (including a module that might fail to load on an old Node).
import { warnIfNodeTooOld } from "./utils/node-version.js";

warnIfNodeTooOld();
