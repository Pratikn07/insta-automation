import "dotenv/config";
const TOKEN = process.env.IG_ACCESS_TOKEN;
const UID = process.env.IG_USER_ID;

const m = await fetch(`https://graph.instagram.com/v21.0/${UID}/media?fields=id,permalink&limit=30&access_token=${TOKEN}`);
const media = (await m.json()).data;
const target = media.find(x => x.permalink.includes("DYqZ_wITPbm"));

// Pull replies from each "Play" comment - see who's replying
const c = await fetch(`https://graph.instagram.com/v21.0/${target.id}/comments?fields=id,text,from,timestamp&access_token=${TOKEN}&limit=20`);
const comments = (await c.json()).data;
const playComments = comments.filter(x => /^play$/i.test(x.text.trim()));

for (const pc of playComments.slice(0, 5)) {
  const r = await fetch(`https://graph.instagram.com/v21.0/${pc.id}/replies?fields=id,text,from,timestamp&access_token=${TOKEN}`);
  const replies = (await r.json()).data || [];
  console.log(`Comment "${pc.text}" by @${pc.from.username} at ${pc.timestamp}`);
  for (const rep of replies) {
    console.log(`  ↳ ${rep.text.slice(0, 60)} (by @${rep.from.username}, ${rep.timestamp})`);
  }
  console.log();
}
