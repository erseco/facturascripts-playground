// initBlueprintEditor() against a happy-dom document. The CodeJar CDN module
// is resolved to a local fake through a module hook so both the CodeJar path
// and the plain-textarea fallback (CDN unreachable) are exercised.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, describe, it, mock } from "node:test";
import { Window } from "happy-dom";

const CODEJAR_URL =
  "https://cdn.jsdelivr.net/npm/codejar@4.3.0/dist/codejar.js";
const FAKE_CODEJAR = `data:text/javascript,${encodeURIComponent(`
export function CodeJar(editor, highlight, options) {
  const jar = globalThis.__codeJarHarness.create(editor, highlight, options);
  return jar;
}`)}`;
let codeJarAvailable = true;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === CODEJAR_URL) {
      if (!codeJarAvailable) {
        throw new Error("CDN unreachable");
      }
      return { url: FAKE_CODEJAR, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const jars = [];
globalThis.__codeJarHarness = {
  create(editor, highlight, options) {
    let code = "";
    let onUpdate = () => {};
    const jar = {
      editor,
      highlight,
      options,
      updates: [],
      toString: () => code,
      updateCode(text, callOnUpdate) {
        code = text;
        jar.updates.push([text, callOnUpdate]);
        editor.textContent = text;
      },
      onUpdate(callback) {
        onUpdate = callback;
      },
      type(text) {
        code = text;
        editor.textContent = text;
        highlight(editor);
        onUpdate(text);
      },
    };
    jars.push(jar);
    return jar;
  },
};

const { initBlueprintEditor } = await import(
  "../src/shell/blueprint-editor.js"
);

const CONFIG = {
  siteTitle: "Cfg",
  admin: { username: "u", password: "p" },
};
const getConfig = () => CONFIG;
const windows = [];
// Drains work that only needs the microtask queue (the stubbed clipboard, the
// data: CodeJar module, the rejected CDN import).
const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
// Gzip runs on the libuv threadpool, so on a loaded machine it can take any
// number of event-loop turns: poll for the outcome against a deadline.
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function setup({
  text = '{"meta":{"title":"T"}}',
  mount = true,
  parts = {},
} = {}) {
  const win = new Window({ url: "https://play.test/app/index.html" });
  windows.push(win);
  globalThis.window = win;
  globalThis.document = win.document;
  win.document.body.innerHTML = `
    <div id="mount" class="is-hidden" contenteditable="true"></div>
    <textarea id="textarea"></textarea>
    <p id="status"></p>
    <button id="run" disabled></button>
    <button id="copy" title="Copy blueprint JSON" aria-label="Copy"><svg></svg></button>`;
  const $ = (id) => win.document.getElementById(id);
  const textarea = $("textarea");
  textarea.value = text;
  const location = {
    href: "https://play.test/app/index.html?scope=s1",
  };
  const elements = {
    mount: mount ? $("mount") : null,
    textarea,
    statusEl: $("status"),
    runButton: $("run"),
    copyButton: $("copy"),
    ...parts,
  };
  return { win, $, location, elements };
}

const type = (win, textarea, value) => {
  textarea.value = value;
  textarea.dispatchEvent(new win.Event("input"));
};

after(async () => {
  hooks.deregister();
  for (const win of windows) {
    await win.happyDOM.close();
  }
});

describe("blueprint editor (fallback textarea)", () => {
  it("validates as the user types and gates the Run button", async () => {
    codeJarAvailable = false;
    const { win, $, location, elements } = setup();
    const editor = initBlueprintEditor(elements, { location, getConfig });
    await settle();

    assert.equal($("textarea").readOnly, false);
    assert.equal($("status").classList.contains("is-valid"), true);
    assert.equal($("run").disabled, false);
    assert.equal($("mount").classList.contains("is-hidden"), true);

    type(win, $("textarea"), "[1]");
    assert.equal($("status").classList.contains("is-invalid"), true);
    assert.match($("status").textContent, /Blueprint must be a JSON object/u);
    assert.equal($("run").disabled, true);
    assert.equal(editor.getCode(), "[1]");
    assert.equal(editor.getValidationResult().valid, false);

    type(win, $("textarea"), "{");
    assert.equal(editor.getValidationResult().valid, false);

    editor.setCode('{"landingPage":"/X"}');
    assert.equal($("textarea").value, '{"landingPage":"/X"}');
    assert.equal(editor.getValidationResult().blueprint.landingPage, "/X");
    assert.equal($("run").disabled, false);

    editor.setLocked(true);
    assert.equal($("run").disabled, true);
    editor.setLocked(false);
    assert.equal($("run").disabled, false);

    editor.setCode(42);
    assert.equal(editor.getCode(), "");
  });

  it("encodes a valid blueprint into the boot URL on Run", async () => {
    codeJarAvailable = false;
    const { win, $, location, elements } = setup({
      text: '{"landingPage":"/Run"}',
    });
    initBlueprintEditor(elements, { location, getConfig });
    const initialHref = location.href;
    $("run").dispatchEvent(new win.Event("click"));
    assert.equal($("run").disabled, true);
    assert.equal($("status").classList.contains("is-running"), true);
    assert.match($("status").textContent, /Encoding blueprint/u);
    await waitFor(() => location.href !== initialHref, "the boot URL");
    const target = new URL(location.href);
    assert.equal(target.searchParams.get("scope"), "s1");
    assert.ok(target.searchParams.get("blueprint"));
  });

  it("does nothing on Run when the blueprint is invalid", async () => {
    codeJarAvailable = false;
    const { win, $, location, elements } = setup({ text: "nope" });
    initBlueprintEditor(elements, { location, getConfig });
    $("run").dispatchEvent(new win.Event("click"));
    await settle();
    assert.equal(location.href, "https://play.test/app/index.html?scope=s1");
    assert.equal($("status").classList.contains("is-invalid"), true);
  });

  it("copies the code and flashes a checkmark, restoring the button", async () => {
    codeJarAvailable = false;
    const { win, $, location, elements } = setup();
    const writes = [];
    let fail = false;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
        clipboard: {
          writeText: async (value) => {
            if (fail) throw new Error("denied");
            writes.push(value);
          },
        },
      },
    });
    initBlueprintEditor(elements, { location, getConfig });
    const originalHtml = $("copy").innerHTML;
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      $("copy").dispatchEvent(new win.Event("click"));
      await settle();
      assert.deepEqual(writes, ['{"meta":{"title":"T"}}']);
      assert.equal($("copy").getAttribute("title"), "Copied!");
      assert.equal($("copy").getAttribute("aria-label"), "Copied!");
      assert.match($("copy").innerHTML, /M3 8\.5/u);
      mock.timers.tick(1200);
      assert.equal($("copy").innerHTML, originalHtml);
      assert.equal($("copy").getAttribute("title"), "Copy blueprint JSON");
      assert.equal($("copy").getAttribute("aria-label"), "Copy");

      fail = true;
      $("copy").dispatchEvent(new win.Event("click"));
      await settle();
      assert.equal($("copy").getAttribute("title"), "Copy blueprint JSON");
    } finally {
      mock.timers.reset();
    }
  });

  it("works without optional elements and attributes", async () => {
    codeJarAvailable = false;
    const { $, elements } = setup({
      mount: false,
      parts: { statusEl: null, runButton: null },
    });
    $("copy").removeAttribute("title");
    $("copy").removeAttribute("aria-label");
    // Without getConfig the defaults cannot be built, so nothing validates.
    const editor = initBlueprintEditor(elements);
    assert.equal(editor.getValidationResult().valid, false);
    editor.setLocked(true);

    const bare = initBlueprintEditor({ textarea: null });
    assert.equal(bare.getCode(), "");
    bare.setCode('{"a":1}');
    assert.equal(bare.getCode(), '{"a":1}');
  });
});

describe("blueprint editor (CodeJar)", () => {
  it("hands editing to CodeJar, carrying focus and highlighting", async () => {
    codeJarAvailable = true;
    const { win, $, location, elements } = setup();
    $("textarea").focus();
    const editor = initBlueprintEditor(elements, { location, getConfig });
    await settle();

    const jar = jars.at(-1);
    assert.equal(jar.editor, $("mount"));
    assert.deepEqual(jar.options, { tab: "  " });
    assert.deepEqual(jar.updates[0], ['{"meta":{"title":"T"}}', false]);
    assert.equal($("mount").classList.contains("is-hidden"), false);
    assert.equal($("textarea").classList.contains("is-hidden"), true);
    assert.equal(win.document.activeElement, $("mount"));
    assert.ok($("mount").innerHTML.includes("<span"));

    // The hidden textarea no longer drives validation.
    type(win, $("textarea"), "[]");
    assert.equal(editor.getValidationResult().valid, true);

    jar.type('{"landingPage":"/Jar"}');
    assert.equal($("textarea").value, '{"landingPage":"/Jar"}');
    assert.equal(editor.getCode(), '{"landingPage":"/Jar"}');
    assert.equal(editor.getValidationResult().blueprint.landingPage, "/Jar");

    editor.setCode('{"landingPage":"/Set"}');
    assert.deepEqual(jar.updates.at(-1), ['{"landingPage":"/Set"}', false]);
    assert.equal(editor.getCode(), '{"landingPage":"/Set"}');
  });

  it("does not steal focus when the textarea was not focused", async () => {
    codeJarAvailable = true;
    const { win, $, location } = setup();
    initBlueprintEditor(
      {
        mount: $("mount"),
        textarea: null,
        statusEl: null,
        runButton: null,
        copyButton: null,
      },
      { location, getConfig },
    );
    await settle();
    assert.notEqual(win.document.activeElement, $("mount"));
    assert.equal($("mount").classList.contains("is-hidden"), false);
  });
});
