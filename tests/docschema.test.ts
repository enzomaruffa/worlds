import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LEXICAL_COMMON_ATTRS, SCHEMA_DEFAULTS, validateTree, type DocSchema } from "../server/docschema";
import { parseManifestPolicies } from "../server/policies";

// Trees are built by hand in the shape Lexical's Yjs binding writes (see the probe in
// docschema.ts): element = embedded XmlText with __type, text run = Map{__type:"text"}
// followed by the string, leaf = Map or XmlElement with __type.

const schema: DocSchema = {
  root: "root",
  typeAttr: "__type",
  commonAttrs: LEXICAL_COMMON_ATTRS,
  nodes: {
    root: { children: ["heading", "paragraph", "image", "decision"] },
    heading: { attrs: { __tag: { enum: ["h1", "h2"] } }, children: ["text"], maxText: 20 },
    paragraph: { children: ["text", "linebreak", "link"] },
    text: {},
    linebreak: {},
    link: { attrs: { __url: { urlPrefix: ["https://"] }, __target: { nullable: true }, __rel: { nullable: true }, __title: { nullable: true } }, children: ["text"] },
    image: { attrs: { __src: { urlPrefix: ["/u/"] }, __alt: { maxLen: 10 } } },
    decision: { attrs: { __id: { ref: "decisions" } } },
  },
  limits: { depth: 4, bytes: SCHEMA_DEFAULTS.bytes, nodes: 50, textChars: 100, perType: { image: 1 } },
};

const base = { __format: 0, __style: "", __indent: 0, __dir: null, __textFormat: 0, __textStyle: "" };

// XmlText indexes count characters, so children are always appended at `length`; the
// index argument is kept only so call sites read in document order.
function element(parent: Y.XmlText, _index: number, type: string, attrs: Record<string, unknown> = {}): Y.XmlText {
  const el = new Y.XmlText();
  parent.insertEmbed(parent.length, el);
  for (const [k, v] of Object.entries({ __type: type, ...base, ...attrs })) el.setAttribute(k, v as string);
  return el;
}

function run(parent: Y.XmlText, _index: number, text: string, attrs: Record<string, unknown> = {}): void {
  const m = new Y.Map();
  parent.insertEmbed(parent.length, m);
  for (const [k, v] of Object.entries({ __type: "text", __format: 0, __style: "", __mode: 0, __detail: 0, ...attrs })) m.set(k, v);
  parent.insert(parent.length, text);
}

function leaf(parent: Y.XmlText, _index: number, type: string, attrs: Record<string, unknown> = {}): void {
  const el = new Y.XmlElement();
  parent.insertEmbed(parent.length, el);
  for (const [k, v] of Object.entries({ __type: type, ...attrs })) el.setAttribute(k, v as string);
}

function doc(build: (root: Y.XmlText) => void): Y.Doc {
  const d = new Y.Doc();
  build(d.get("root", Y.XmlText));
  return d;
}

const ok = (d: Y.Doc) => validateTree(d, schema).violation;

describe("doc schema", () => {
  test("a well-formed document passes and reports its refs", () => {
    const d = doc((root) => {
      const h = element(root, 0, "heading", { __tag: "h1" });
      run(h, 0, "Title");
      const p = element(root, 1, "paragraph");
      run(p, 0, "Hello ");
      run(p, 2, "bold", { __format: 1 });
      const m = new Y.Map();
      p.insertEmbed(p.length, m);
      m.set("__type", "linebreak");
      const link = element(p, 5, "link", { __url: "https://x.y", __target: null, __rel: null, __title: null });
      run(link, 0, "link");
      leaf(root, 2, "image", { __src: "/u/site/a.png", __alt: "pic" });
      leaf(root, 3, "decision", { __id: "doc_abc" });
    });
    const check = validateTree(d, schema);
    expect(check.violation).toBeNull();
    expect(check.refs).toEqual([{ collection: "decisions", id: "doc_abc" }]);
  });

  test("an undeclared node type is refused", () => {
    const v = ok(doc((root) => element(root, 0, "script")));
    expect(v?.rule).toBe("type");
    expect(v?.message).toContain('"script"');
  });

  test("nesting follows the children lists", () => {
    const v = ok(doc((root) => {
      const h = element(root, 0, "heading", { __tag: "h1" });
      element(h, 0, "paragraph");
    }));
    expect(v?.rule).toBe("nesting");
  });

  test("attributes must be declared and in range", () => {
    expect(ok(doc((root) => element(root, 0, "heading", { __tag: "h4" })))?.rule).toBe("attr");
    expect(ok(doc((root) => element(root, 0, "paragraph", { __onclick: "x" })))?.message).toContain("__onclick");
    expect(ok(doc((root) => leaf(root, 0, "image", { __src: "/u/s/a.png", __alt: "far too long alt" })))?.message).toContain("__alt");
  });

  test("urls must start with an allowed prefix", () => {
    expect(ok(doc((root) => leaf(root, 0, "image", { __src: "https://evil/x.png" })))?.rule).toBe("url");
    expect(ok(doc((root) => {
      const p = element(root, 0, "paragraph");
      element(p, 0, "link", { __url: "javascript:alert(1)", __target: null, __rel: null, __title: null });
    }))?.rule).toBe("url");
  });

  test("text outside a run, per-type caps, text caps and depth are enforced", () => {
    expect(ok(doc((root) => root.insert(0, "loose")))?.rule).toBe("shape");
    expect(ok(doc((root) => {
      leaf(root, 0, "image", { __src: "/u/s/1.png" });
      leaf(root, 1, "image", { __src: "/u/s/2.png" });
    }))?.message).toContain('more than 1 "image"');
    expect(ok(doc((root) => {
      const h = element(root, 0, "heading", { __tag: "h2" });
      run(h, 0, "x".repeat(21));
    }))?.message).toContain("more than 20 characters");
    expect(ok(doc((root) => {
      const p = element(root, 0, "paragraph");
      run(p, 0, "y".repeat(101));
    }))?.message).toContain("more than 100 characters");
    expect(ok(doc((root) => {
      let cur = element(root, 0, "paragraph");
      for (let i = 0; i < 5; i++) cur = element(cur, 0, "link", { __url: "https://a", __target: null, __rel: null, __title: null });
    }))?.rule).toBeOneOf(["limit", "nesting"]);
  });

  test("object attributes: a nested Y.Map of node state is checked key by key", () => {
    const withState = {
      ...schema,
      nodes: {
        ...schema.nodes,
        root: { children: ["chart"] },
        chart: { attrs: { __state: { type: "object", props: { "chart-spec": { type: "json", maxLen: 20 }, "chart-title": { maxLen: 10, nullable: true } } } } },
      },
    } as DocSchema;
    const chart = (state: Record<string, unknown>) =>
      doc((root) => {
        const el = new Y.XmlElement();
        root.insertEmbed(root.length, el);
        el.setAttribute("__type", "chart");
        const m = new Y.Map();
        el.setAttribute("__state", m as never);
        for (const [k, v] of Object.entries(state)) m.set(k, v);
      });
    expect(validateTree(chart({ "chart-spec": '{"mark":"bar"}' }), withState).violation).toBeNull();
    expect(validateTree(chart({ "chart-spec": "not json" }), withState).violation?.message).toContain("__state.chart-spec");
    expect(validateTree(chart({ "chart-spec": "{}", evil: 1 }), withState).violation?.message).toContain('undeclared key "evil"');
    expect(validateTree(chart({ "chart-spec": '{"mark":"bar","x":"a very long value"}' }), withState).violation?.rule).toBe("attr");
    // a plain JSON object works the same way, and `open` admits extra keys
    const open = { ...withState, nodes: { ...withState.nodes, chart: { attrs: { __state: { type: "object", open: true, props: {} } } } } } as DocSchema;
    expect(validateTree(chart({ anything: "goes" }), open).violation).toBeNull();
    const plain = doc((root) => {
      const el = new Y.XmlElement();
      root.insertEmbed(root.length, el);
      el.setAttribute("__type", "chart");
      el.setAttribute("__state", { "chart-spec": "{}" } as never);
    });
    expect(validateTree(plain, withState).violation).toBeNull();
  });

  test("a stray top-level shared type is refused", () => {
    const d = new Y.Doc();
    d.get("root", Y.XmlText);
    d.get("side", Y.Map).set("x", 1);
    expect(validateTree(d, schema).violation?.rule).toBe("shape");
  });

  test("the state byte limit is checked first", () => {
    const tiny = { ...schema, limits: { ...schema.limits, bytes: 10 } };
    expect(validateTree(new Y.Doc(), tiny, 11).violation?.rule).toBe("limit");
  });
});

describe(".world.json docs section", () => {
  test("parses defaults and rejects undeclared children", () => {
    const p = parseManifestPolicies({ docs: { "plan-*": { nodes: { root: { children: ["paragraph"] }, paragraph: { children: ["text"] }, text: {} } } } });
    const s = p.docs["plan-*"]!;
    expect(s.root).toBe("root");
    expect(s.typeAttr).toBe("__type");
    expect(s.commonAttrs.__format).toBeDefined();
    expect(s.limits.depth).toBe(20);
    expect(() => parseManifestPolicies({ docs: { x: { nodes: { root: { children: ["ghost"] } } } } })).toThrow(/undeclared type "ghost"/);
    expect(() => parseManifestPolicies({ docs: { x: { nodes: { paragraph: {} } } } })).toThrow(/declare the root node/);
    expect(() => parseManifestPolicies({ docs: { x: { nodes: { root: { attrs: { a: { type: "float" } } } } } } })).toThrow(/type must be one of/);
    const withProps = parseManifestPolicies({ docs: { x: { nodes: { root: { attrs: { __state: { type: "object", props: { k: { maxLen: 3 } } } } } } } } });
    expect(withProps.docs.x!.nodes.root!.attrs!.__state!.props!.k!.maxLen).toBe(3);
    expect(() => parseManifestPolicies({ docs: { x: { nodes: { root: { attrs: { s: { type: "object" } } } } } } })).toThrow(/needs props or open/);
    expect(() => parseManifestPolicies({ docs: { x: { nodes: { root: { attrs: { s: { props: { k: {} } } } } } } } })).toThrow(/needs type "object"/);
  });
});
