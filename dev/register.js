// Use with: node --import ./dev/register.js <script>
import { register } from "node:module";

register("./loader.js", import.meta.url);
