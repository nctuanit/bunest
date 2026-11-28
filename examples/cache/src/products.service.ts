import { Injectable, NotFoundException } from "@bunest/core";
import { CacheEvict, CachePut, Cacheable } from "@bunest/cache";

export interface ProductRecord {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly loadCount: number;
}

@Injectable()
export class ProductsService {
  private readonly store = new Map<string, { id: string; name: string; price: number }>([
    ["p1", { id: "p1", name: "Mechanical Keyboard", price: 149 }],
    ["p2", { id: "p2", name: "Ultrawide Monitor", price: 699 }],
  ]);
  public dbReads = 0;

  @Cacheable({
    key: (id: string) => `product:${id}`,
    ttl: 5000,
    tags: (id: string) => [`product:${id}`, "products"],
  })
  async findOne(id: string): Promise<ProductRecord> {
    this.dbReads += 1;
    const item = this.store.get(id);
    if (!item) {
      throw new NotFoundException(`Product "${id}" not found`);
    }
    return { ...item, loadCount: this.dbReads };
  }

  @CachePut({
    key: (id: string) => `product:${id}`,
    ttl: 5000,
    tags: (id: string) => [`product:${id}`, "products"],
  })
  async updatePrice(id: string, price: number): Promise<ProductRecord> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new NotFoundException(`Product "${id}" not found`);
    }
    const updated = { ...existing, price };
    this.store.set(id, updated);
    return { ...updated, loadCount: this.dbReads };
  }

  @CacheEvict({ tags: ["products"] })
  async invalidateAllProducts(): Promise<{ invalidated: boolean }> {
    return { invalidated: true };
  }
}
