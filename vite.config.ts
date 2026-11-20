import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { desktopLicenses } from "./scripts/license-plugin";

export default defineConfig({
  root: "apps/desktop",
  plugins: [react(), ...desktopLicenses()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
