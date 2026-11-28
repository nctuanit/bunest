import { Body, Controller, Get, Post, Redirect, Render } from "@bunest/core";

export interface GuestbookEntry {
  readonly author: string;
  readonly text: string;
}

@Controller()
export class AppController {
  private readonly entries: GuestbookEntry[] = [
    { author: "Ada", text: "Welcome to Bunest MVC!" },
  ];

  @Get()
  @Render("index")
  root() {
    return {
      title: "Bunest MVC Guestbook",
      heading: "Bunest Server-Side Rendering",
      message: "Rendered natively on Bun with automatic HTML escaping.",
      entries: this.entries,
    };
  }

  @Post("entries")
  @Redirect("/", 303)
  addEntry(@Body() body: { author?: string; text?: string }) {
    const author = String(body?.author ?? "Anonymous").trim();
    const text = String(body?.text ?? "").trim();
    if (text.length > 0) {
      this.entries.push({ author, text });
    }
    return { url: "/", statusCode: 303 };
  }
}
