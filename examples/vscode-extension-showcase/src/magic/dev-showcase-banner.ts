import { Injectable } from "@bunest/core";

@Injectable()
export class DevShowcaseBanner {
  getBanner(): string {
    return "Bunest Showcase";
  }
}
