import { assertCard, buildMenuCard } from "./cards.mjs";
import { getCollectionStatus } from "./teslamate.mjs";
import { getRuntimeState } from "./store.mjs";
import { pushPreviewCards, pushReportCards } from "./bot.mjs";

const command = process.argv[2];

if (command === "status") {
  console.log(JSON.stringify(await getCollectionStatus(), null, 2));
} else if (command === "menu") {
  console.log(JSON.stringify(assertCard(buildMenuCard()), null, 2));
} else if (command === "push-preview") {
  const state = await getRuntimeState();
  if (!state.chat_id) throw new Error("还没有飞书单聊会话，请先给机器人发送“菜单”。");
  await pushPreviewCards(state.chat_id, `preview-${Date.now()}`);
  console.log("preview cards sent");
} else if (command === "push-reports") {
  const state = await getRuntimeState();
  if (!state.chat_id) throw new Error("还没有飞书单聊会话，请先给机器人发送“菜单”。");
  await pushReportCards(state.chat_id, `reports-${Date.now()}`);
  console.log("report cards sent");
} else {
  console.error("usage: node src/cli.mjs <status|menu|push-preview|push-reports>");
  process.exitCode = 2;
}
