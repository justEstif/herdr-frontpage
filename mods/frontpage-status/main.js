// frontpage-status: a one-line strip for the top of the frontpage layout.
// Reads the counts the frontpage mod publishes to shared state.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, shared } from "herdr";

export default class FrontpageStatus extends View {
  render(_cx) {
    const t = theme();
    const c = shared("frontpage:counts") ?? {};
    const parts = [
      `queue ${c.queue ?? 0}`,
      `saved ${c.saved ?? 0}`,
      `events ${c.events ?? 0}`,
    ];
    return h_flex()
      .id("root")
      .size_full()
      .px(10)
      .items_center()
      .gap(10)
      .bg(t.chrome)
      .child(div().text_size(11).font_semibold().text_color(t.accent).child("frontpage"))
      .child(div().text_size(11).text_color(t.muted).child(parts.join(" · ")))
      .child(div().flex_1())
      .child(
        div()
          .text_size(11)
          .text_color(t.accent)
          .child("[/] rail")
      )
      .child(
        div()
          .px(6)
          .text_size(11)
          .text_color(t.dim)
          .child(c.onboarded === false ? "onboarding — rate 5 to tune your queue" : "local only · nothing leaves your machine")
      );
  }
}
