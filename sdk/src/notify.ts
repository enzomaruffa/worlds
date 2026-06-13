import { call } from "./http";

// Sends are capped and stamped server-side with the site + sender. Notify, never impersonate.
export const notify = {
  slack: (target: string, text: string) => call("POST", "/api/v1/notify/slack", { target, text }),
};
