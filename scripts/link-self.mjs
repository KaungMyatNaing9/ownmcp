import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";

mkdirSync("node_modules", { recursive: true });
const dest = "node_modules/ownmcp";
try {
  const stat = lstatSync(dest);
  if (stat.isSymbolicLink() && readlinkSync(dest) === "..") process.exit(0);
  rmSync(dest, { recursive: true, force: true });
} catch {
  // The link is not there yet.
}
symlinkSync("..", dest, "dir");
