export interface Hero {
  readonly id: number;
  readonly name: string;
  readonly power: number;
}

export interface HeroById {
  readonly id: number;
}

export interface FindManyRequest {
  readonly minPower?: number;
}

export const HERO_GRPC_CLIENT = Symbol("HERO_GRPC_CLIENT");
