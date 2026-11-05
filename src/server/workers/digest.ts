import "dotenv/config";
import { generateDigest } from "../digest/digest.js";

// Run directly: `npm run worker:digest [-- YYYY-MM-DD [YYYY-MM-DD]]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const start = process.argv[2];
  const end = process.argv[3];
  generateDigest(start ? { start, end } : {})
    .then((r) => {
      console.log(r ? `[digest] done: "${r.title}" (${r.itemCount} items)` : "[digest] nothing to generate");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { generateDigest };
