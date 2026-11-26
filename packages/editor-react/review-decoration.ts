import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { reviewRanges, type ReviewMark, type ReviewSnapshot } from "./review-projection";

const review = new PluginKey<{ generation: number; decorations: DecorationSet }>("workbenchReview");

export function reviewDecorations() {
  return new Plugin({
    key: review,
    state: {
      init: () => ({ generation: 0, decorations: DecorationSet.empty }),
      apply(tr, value) {
        return tr.docChanged ? { generation: value.generation + 1, decorations: DecorationSet.empty }
          : { generation: value.generation, decorations: tr.getMeta(review) as DecorationSet | undefined ?? value.decorations };
      },
    },
    props: { decorations: state => review.getState(state)?.decorations },
  });
}

export function reviewGeneration(view: EditorView) {
  return review.getState(view.state)!.generation;
}

export function setReviewMarks(view: EditorView, snapshot?: ReviewSnapshot, marks: ReviewMark[] = []) {
  const decorations = snapshot ? DecorationSet.create(view.state.doc, marks.flatMap(mark => mark.range
    ? reviewRanges(snapshot.projection, mark.range).map(range => Decoration.inline(range.from, range.to, {
      class: mark.category === "ai_generated" ? "review-mark review-mark-ai" : "review-mark review-mark-suspected",
      "data-review-id": mark.id,
    })) : [])) : DecorationSet.empty;
  view.dispatch(view.state.tr.setMeta(review, decorations).setMeta("addToHistory", false));
}
