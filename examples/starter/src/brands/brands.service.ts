import { ConflictException, Injectable, NotFoundException } from "@bunest/core";
import { InjectRepository, type OrmRepository } from "@bunest/orm";
import type { CreateBrandDto } from "./brand.dto";
import { BrandEntity } from "./brand.entity";

@Injectable()
export class BrandsService {
  constructor(
    @InjectRepository(BrandEntity)
    private readonly brandRepo: OrmRepository<BrandEntity>,
  ) {}

  findAll(): Promise<BrandEntity[]> {
    return this.brandRepo.find({
      relations: { shoes: true },
      order: { name: "ASC" },
    });
  }

  async findOne(id: number): Promise<BrandEntity> {
    const brand = await this.brandRepo.findOne({
      where: { id },
      relations: { shoes: true },
    });
    if (!brand) {
      throw new NotFoundException(`Brand #${id} not found`);
    }
    return brand;
  }

  async findByName(name: string): Promise<BrandEntity | null> {
    return this.brandRepo.findOne({ where: { name } });
  }

  async create(dto: CreateBrandDto): Promise<BrandEntity> {
    const existing = await this.brandRepo.findOne({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException(`Brand "${dto.name}" already exists`);
    }
    return this.brandRepo.save({
      name: dto.name,
      country: dto.country,
    });
  }
}
