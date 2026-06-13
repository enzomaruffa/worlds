import { call } from "./http";

export const uploads = {
  put: (file: Blob, opts: { name?: string } = {}) => {
    const form = new FormData();
    form.set("file", file);
    if (opts.name) form.set("name", opts.name);
    return call("POST", "/api/v1/uploads", form);
  },
  list: () => call("GET", "/api/v1/uploads"),
  delete: (name: string) => call("DELETE", `/api/v1/uploads/${encodeURIComponent(name)}`),
};
