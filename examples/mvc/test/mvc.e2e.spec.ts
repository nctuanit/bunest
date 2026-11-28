import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule, configureMvcApp } from "../src/app.module";

describe("MVC & Server-Side Rendering (NestJS 15-mvc / 17-mvc-handlebars E2E)", () => {
  it("renders @Render('index') HTML, escapes XSS input on form POST + @Redirect, and serves static CSS", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    configureMvcApp(app);
    await app.init();

    try {
      // 1. GET / -> server-rendered HTML
      const homeRes = await app.fetch(new Request("http://localhost/"));
      expect(homeRes.status).toBe(200);
      expect(homeRes.headers.get("content-type")).toContain("text/html");
      const homeHtml = await homeRes.text();
      expect(homeHtml).toContain("<title>Bunest MVC Guestbook</title>");
      expect(homeHtml).toContain("<strong>Ada</strong>: Welcome to Bunest MVC!");

      // 2. POST /entries (URL-encoded form with XSS payload) -> 303 redirect
      const postRes = await app.fetch(
        new Request("http://localhost/entries", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            author: "<script>alert(1)</script>",
            text: "Hello & welcome!",
          }),
        }),
      );
      expect(postRes.status).toBe(303);
      expect(postRes.headers.get("location")).toBe("/");

      // 3. Re-render GET / -> new entry appears HTML-escaped
      const updatedHtml = await (
        await app.fetch(new Request("http://localhost/"))
      ).text();
      expect(updatedHtml).not.toContain("<script>alert(1)</script>");
      expect(updatedHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(updatedHtml).toContain("Hello &amp; welcome!");

      // 4. Static CSS served from /static/styles.css
      const cssRes = await app.fetch(
        new Request("http://localhost/static/styles.css"),
      );
      expect(cssRes.status).toBe(200);
      expect(await cssRes.text()).toContain("font-family");
    } finally {
      await app.close();
    }
  });
});
