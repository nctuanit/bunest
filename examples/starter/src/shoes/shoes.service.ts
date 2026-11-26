import {
  ConflictException,
  Injectable,
  NotFoundException,
  mergeDefined,
  type Logger,
} from "@bunest/core";
import { InjectRepository, type OrmRepository } from "@bunest/orm";
import { BrandEntity } from "../brands/brand.entity";
import type { CreateShoeDto, UpdateShoeDto } from "./shoe.dto";
import { ShoeEntity } from "./shoe.entity";
import { ShoeRepository } from "./shoe.repository";

@Injectable()
export class ShoesService {

  constructor(
    private readonly shoeRepo: ShoeRepository,
    @InjectRepository(ShoeEntity)
    private readonly shoeOrmRepo: OrmRepository<ShoeEntity>,
    @InjectRepository(BrandEntity)
    private readonly brandRepo: OrmRepository<BrandEntity>,
  ) { }

  async findAll(filters?: {
    brandId?: number;
    category?: string;
    q?: string;
    minPrice?: number;
    maxPrice?: number;
  }) {
    if (
      filters?.q ||
      filters?.minPrice !== undefined ||
      filters?.maxPrice !== undefined
    ) {
      const pattern = filters.q ? `%${filters.q.trim()}%` : "%";
      return this.shoeRepo.searchShoes({
        pattern,
        minPrice: filters.minPrice,
        maxPrice: filters.maxPrice,
      });
    }
    if (filters?.brandId !== undefined) {
      return this.shoeOrmRepo.find({
        where: { brand: { id: filters.brandId }, active: true },
        relations: { brand: true },
      });
    }
    if (filters?.category) {
      return this.shoeOrmRepo.find({
        where: { category: filters.category, active: true },
        relations: { brand: true },
      });
    }
    return this.shoeOrmRepo.find({
      where: { active: true },
      relations: { brand: true },
    });
  }

  async findOne(id: number): Promise<ShoeEntity> {
    const shoe = await this.shoeOrmRepo.findOne({
      where: { id },
      relations: { brand: true },
    });
    if (!shoe) {
      throw new NotFoundException(`Shoe #${id} not found`);
    }
    return shoe;
  }

  async create(dto: CreateShoeDto): Promise<ShoeEntity> {
    if (await this.shoeRepo.existsBySku(dto.sku)) {
      throw new ConflictException(`SKU "${dto.sku}" already exists`);
    }
    const brand = await this.brandRepo.findOne({ where: { id: dto.brandId } });
    if (!brand) {
      throw new NotFoundException(`Brand #${dto.brandId} not found`);
    }

    const created = await this.shoeOrmRepo.save({
      sku: dto.sku,
      name: dto.name,
      brand,
      category: dto.category,
      size: dto.size,
      price: dto.price,
      stock: dto.stock ?? 0,
      active: dto.active ?? true,
    });
    this.logger.log(
      `Added shoe ${created.sku} — ${created.name} [${brand.name}] (${created.price} VND)`,
    );
    return this.findOne(created.id);
  }



  async update(id: number, dto: UpdateShoeDto): Promise<ShoeEntity> {
    const existing = await this.findOne(id);
    const { brandId, ...fields } = dto;
    let brand = existing.brand;
    if (brandId !== undefined) {
      const nextBrand = await this.brandRepo.findOne({ where: { id: brandId } });
      if (!nextBrand) {
        throw new NotFoundException(`Brand #${brandId} not found`);
      }
      brand = nextBrand;
    }
    await this.shoeOrmRepo.save(mergeDefined(existing, { ...fields, brand }));
    return this.findOne(id);
  }

  async remove(id: number): Promise<{ deleted: true; id: number }> {
    await this.findOne(id);
    await this.shoeRepo.deleteById(id);
    this.logger.log(`Deleted shoe #${id}`);
    return { deleted: true, id };
  }
}
