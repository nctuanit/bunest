import { Controller, Get, StreamableFile } from "@bunest/core";

@Controller()
export class AppController {
  @Get("info")
  getInfo() {
    return {
      name: "bunest-serve-static",
      version: "1.0.0",
      runtime: "bun",
    };
  }

  @Get("download")
  downloadReport(): StreamableFile {
    const csv = "id,name\n1,Bunest\n2,Static\n";
    return new StreamableFile(new TextEncoder().encode(csv), {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="report.csv"',
    });
  }
}
