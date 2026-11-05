import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

/**
 * One-time interactive login on YOUR machine to produce a string session.
 *   1) Get api_id / api_hash at https://my.telegram.org → set them here in .env
 *   2) Run: npm run telegram:login
 *   3) Enter phone (+country), the code Telegram sends, and 2FA if any
 *   4) Copy the printed TELEGRAM_SESSION into your server's env vars
 * The password is never stored — only the resulting session string.
 */
async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    console.error("먼저 .env 에 TELEGRAM_API_ID, TELEGRAM_API_HASH 를 넣으세요 (my.telegram.org).");
    process.exit(1);
  }
  const rl = readline.createInterface({ input, output });
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  await client.start({
    phoneNumber: async () => (await rl.question("전화번호 (예: +8210...): ")).trim(),
    password: async () => (await rl.question("2단계 비밀번호 (없으면 그냥 엔터): ")).trim(),
    phoneCode: async () => (await rl.question("텔레그램으로 받은 코드: ")).trim(),
    onError: (e) => console.error(e),
  });
  const session = client.session.save();
  console.log("\n===== 아래 한 줄을 TELEGRAM_SESSION 환경변수에 넣으세요 =====\n");
  console.log(session);
  console.log("\n=============================================================\n");

  // List the account's channels/groups so private channels can be added by id.
  try {
    const dialogs = await client.getDialogs({ limit: 500 });
    console.log("===== 내 채널/그룹 (아이디  ←  제목) =====");
    console.log("(비공개 채널은 @이름이 없으니 아래 '아이디'를 소스에 넣으세요)\n");
    for (const d of dialogs) {
      if (d.isChannel || d.isGroup) {
        console.log(`${d.id?.toString()}\t${d.title ?? ""}`);
      }
    }
    console.log("\n=============================================================\n");
  } catch (e) {
    console.error("채널 목록을 불러오지 못했습니다:", e);
  }

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
