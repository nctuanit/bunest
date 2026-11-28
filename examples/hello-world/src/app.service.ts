import { Injectable } from "@bunest/core";

@Injectable()
export class AppService {
  getGreeting(name?: string): { message: string; runtime: string } {
    const target = name?.trim() || "Bunest";
    return {
      message: `Hello, ${target}!`,
      runtime: `Bun ${Bun.version}`,
    };
  }
}
