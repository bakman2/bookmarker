import { q } from "../src/db";

// minimal demo dataset: one category, one bookmark
const groups = [
  {
    name: "example",
    links: [
      { title: "Example", description: "example.com", address: "https://example.com", verify: "http" },
    ],
  },
];

const theme = {
  title_text: "Bookmarks",
  title: "show",
  background: "bg-gray-700",
  heading: "text-gray-200",
  item: "text-white/80 bg-gray-500/40 hover:bg-gray-500/80 hover:shadow cursor-pointer rounded",
  item_subtitle: "text-white/60",
  gap: "gap-2",
  subtitle: "show",
};

if (q.groups.get()) {
  console.error("Database already contains data, aborting seed.");
  process.exit(1);
}

groups.forEach((g, gi) => {
  const r = q.insertGroup.run(g.name, gi);
  const gid = Number(r.lastInsertRowid);
  g.links.forEach((b, bi) => {
    q.insertBookmark.run(
      gid,
      b.title,
      b.address,
      b.description ?? null,
      bi,
      b.verify === "ping" ? "tcp" : b.verify,
      0,
      1
    );
  });
});

q.setSetting.run("theme", JSON.stringify(theme));
console.log("Seeded", groups.length, "group(s)");
