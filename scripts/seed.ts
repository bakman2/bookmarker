import { q } from "../src/db";

const dataset = {
  bookmarks: [
    {
      group: "connectivity",
      links: [
        { title: "router", description: "ubiquity ERX", address: "http://192.0.2.1", verify: "http" },
        { title: "unifi", description: "accesspoint", address: "https://192.0.2.180:8443", verify: "http" },
      ],
    },
    { group: "servers", links: [{ title: "Proxmox", address: "https://192.0.2.3:8006", verify: "http" }] },
    {
      group: "home automation",
      links: [
        { title: "Node-RED", address: "http://192.0.2.4:1880", verify: "http" },
        { title: "Zigbee2mqtt", address: "http://192.0.2.170:8080/", verify: "http" },
        { title: "Home Assistant", address: "http://homeassistant.example:8123", verify: "http" },
        { title: "Homebridge", address: "http://192.0.2.173:8581/", verify: "http" },
      ],
    },
    {
      group: "media",
      links: [
        { title: "Spotweb", address: "http://192.0.2.7:8085", verify: "http" },
        { title: "Sonarr", address: "http://192.0.2.194:8989", verify: "http" },
        { title: "Radarr", address: "http://192.0.2.194:7878", verify: "http" },
        { title: "qBittorrent", address: "http://192.0.2.194:8080", verify: "http" },
        { title: "nzbget", address: "http://192.0.2.7:6789", verify: "http" },
        { title: "Zidoo", address: "http://192.0.2.9:9528/pc/", verify: "http" },
        { title: "Jackett", address: "http://192.0.2.194:9117", verify: "http" },
      ],
    },
  ],
  theme: {
    title_text: "Bookmarks",
    title: "show",
    background: "bg-gray-700",
    item: "text-white/80 bg-gray-500/40 hover:bg-gray-500/80 hover:shadow cursor-pointer rounded",
    item_subtitle: "text-white/60",
    gap: "gap-2",
    subtitle: "show",
  },
};

if (q.groups.get()) {
  console.error("Database already contains data, aborting seed.");
  process.exit(1);
}

dataset.bookmarks.forEach((g, gi) => {
  const r = q.insertGroup.run(g.group, gi);
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

q.setSetting.run("theme", JSON.stringify(dataset.theme));
console.log("Seeded", dataset.bookmarks.length, "groups");
