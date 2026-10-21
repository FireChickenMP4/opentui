import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "../Renderable.js"
import { BoxRenderable, type BoxOptions } from "../renderables/Box.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable, type TextOptions } from "../renderables/Text.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import Yoga, { Edge, FlexDirection } from "../yoga.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

beforeEach(async () => {
  ;({ renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 30 }))
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

function expectLayout(renderable: TextRenderable | TextareaRenderable, width: number, height: number): void {
  const layout = renderable.getLayout()
  expect(renderable.width).toBeCloseTo(width, 5)
  expect(renderable.height).toBeCloseTo(height, 5)
  expect(layout.width).toBeCloseTo(width, 5)
  expect(layout.height).toBeCloseTo(height, 5)
}

for (const kind of ["text", "textarea"] as const) {
  describe(`native-backed ${kind} measurement parity`, () => {
    const create = (
      content: string,
      options: Pick<TextOptions, "wrapMode" | "alignSelf" | "position" | "left" | "top"> = {},
    ) =>
      kind === "text"
        ? new TextRenderable(renderer, { content, ...options })
        : new TextareaRenderable(renderer, { initialValue: content, ...options })

    // Fixed expectations from the former TypeScript Yoga measurement functions.
    test.each([
      ["char", "ABCDEFGHIJKLMNOPQRST", 20, 1],
      ["word", "Hello wonderful world from OpenTUI", 34, 1],
      ["none", "Short\nAVeryLongLineHere\nMedium", 17, 3],
      ["char", "", 1, 1],
    ] as const)("%s wrap measures %j", async (wrapMode, content, width, height) => {
      const node = create(content, { wrapMode, alignSelf: "flex-start" })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, width, height)
    })

    test("stretches relative content to the root width by default", async () => {
      const node = create("Short", { wrapMode: "char" })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, 80, 1)
    })

    test("clamps to a narrower parent and removes clamping for absolute positioning", async () => {
      const parent = new BoxRenderable(renderer, { width: 10, alignItems: "flex-start" })
      const node = create("ABCDEFGHIJKLMNOPQRST", { wrapMode: "none", alignSelf: "flex-start", left: 0, top: 0 })
      parent.add(node)
      renderer.root.add(parent)
      for (const [position, width] of [
        ["relative", 10],
        ["absolute", 20],
        ["relative", 10],
      ] as const) {
        node.position = position
        await renderOnce()
        expectLayout(node, width, 1)
      }
    })

    test("measures initially absolute content without AtMost clamping", async () => {
      const node = create("ABCDEFGHIJKLMNOPQRST", { wrapMode: "none", position: "absolute", left: 0, top: 0 })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, 20, 1)
    })

    test("recomputes measurement after content changes", async () => {
      const node = create("Short", { wrapMode: "char", alignSelf: "flex-start" })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, 5, 1)
      if (node instanceof TextRenderable) node.content = "ABCDEFGHIJKLMNOPQRST"
      else node.setText("ABCDEFGHIJKLMNOPQRST")
      await renderOnce()
      expectLayout(node, 20, 1)
    })
  })
}

describe("measured text stays inside its parent's rounded content box", () => {
  const box = (options: BoxOptions, children: Renderable[] = []) => {
    const node = new BoxRenderable(renderer, options)
    for (const child of children) node.add(child)
    return node
  }
  const text = (content: string, options: TextOptions = {}) =>
    new TextRenderable(renderer, { content, wrapMode: "char", ...options })
  const spans = (nodes: Renderable[]) => nodes.map((node) => `${node.x}+${node.width}`).join(" ")
  const line = (row: number) => captureCharFrame().split("\n")[row]!

  // Fractional columns: text rounding ceiled each text's right edge past its column.
  test.each([
    [{ width: 10 }, "abc", "0+3 3+4 7+3", "aaabbbbccc  "],
    [{ width: 11, paddingRight: 1 }, "abc", "0+3 3+4 7+3", "aaabbbbccc  "],
    [{ width: 11, paddingLeft: 1 }, "abc", "1+3 4+4 8+3", " aaabbbbccc "],
    [{ width: 21 }, "ab", "0+11 11+10", "aaaaaaaaaaabbbbbbbbbb  "],
  ] as const)("equal columns in %o", async (options, letters, expected, frame) => {
    const texts = [...letters].map((letter) => text(letter.repeat(33)))
    renderer.root.add(
      box(
        { flexDirection: "row", height: 4, ...options },
        texts.map((t) => box({ flexGrow: 1, flexBasis: 0 }, [t])),
      ),
    )
    await renderOnce()
    expect(spans(texts)).toBe(expected)
    expect(line(0).slice(0, frame.length)).toBe(frame)
  })

  test("shrinking sibling texts do not overlap", async () => {
    const texts = [text("aaaaaaaa"), text("bbbbbbbb")]
    renderer.root.add(box({ flexDirection: "row", width: 11 }, texts))
    await renderOnce()
    expect(spans(texts)).toBe("0+6 6+5")
  })

  test("wrapped text fits beside a visible ScrollBox scrollbar", async () => {
    const scroll = new ScrollBoxRenderable(renderer, { height: 4 })
    const node = text("0123456789".repeat(20), { width: "100%" })
    scroll.add(node)
    renderer.root.add(box({ width: 20 }, [scroll]))
    await renderOnce()
    await renderOnce()
    expect([scroll.verticalScrollBar.visible, node.width, scroll.content.width]).toEqual([true, 19, 19])
    expect(line(1).slice(0, 4)).toBe("9012")
  })
})

describe("the public yoga.ts API keeps upstream rounding", () => {
  test("measured nodes round as text and positions round relative to the parent", () => {
    const config = Yoga.Config.create()
    const root = Yoga.Node.create(config)
    const parent = Yoga.Node.create(config)
    const child = Yoga.Node.create(config)
    const measured = Yoga.Node.create(config)
    root.setFlexDirection(FlexDirection.Row)
    measured.setMargin(Edge.Left, 0.5)
    measured.setMeasureFunc(() => ({ width: 5.5, height: 1 }))
    parent.setMargin(Edge.Left, 0.5)
    parent.setWidth(20)
    child.setMargin(Edge.Left, 0.6)
    child.setWidth(5)
    parent.insertChild(child, 0)
    root.insertChild(measured, 0)
    root.insertChild(parent, 1)
    root.calculateLayout(40, 10)
    // Text rounding floors the measured node's left and keeps 6 cells; the child rounds its own 0.6.
    expect([measured.getComputedLeft(), measured.getComputedWidth(), child.getComputedLeft()]).toEqual([0, 6, 1])
    root.freeRecursive()
    config.free()
  })
})

test("empty textarea measures its placeholder", async () => {
  const node = new TextareaRenderable(renderer, {
    initialValue: "",
    placeholder: "Placeholder text that is longer than content",
    wrapMode: "char",
    alignSelf: "flex-start",
  })
  renderer.root.add(node)
  await renderOnce()
  expectLayout(node, 44, 1)
})
