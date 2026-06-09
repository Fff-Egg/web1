import "dotenv/config";
import { generateDigest } from "../digest/digest.js";

// Run directly: `npm run worker:digest [-- YYYY-MM-DD]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const date = process.argv[2];
  generateDigest(date)
    .then((r) => {
      console.log(r ? `[digest] done: ${r.date} (${r.itemCount} items)` : "[digest] nothing to generate");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { generateDigest };
