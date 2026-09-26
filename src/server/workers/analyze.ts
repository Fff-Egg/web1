import "dotenv/config";
import { runAnalysis } from "../analysis/analyze.js";

// Run directly: `npm run worker:analyze`
if (import.meta.url === `file://${process.argv[1]}`) {
  runAnalysis()
    .then((r) => {
      console.log(`[analyze] done: analyzed=${r.analyzed} relevant=${r.relevant} errors=${r.errors}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { runAnalysis };
