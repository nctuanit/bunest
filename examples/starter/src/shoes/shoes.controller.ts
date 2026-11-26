import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from "@bunest/core";
import { CreateShoeDto, UpdateShoeDto } from "./shoe.dto";
import { ShoesService } from "./shoes.service";

@Controller("shoes")
export class ShoesController {
  constructor(private readonly shoesService: ShoesService) {}

  @Get()
  findAll(
    @Query("brandId") brandId?: string,
    @Query("category") category?: string,
    @Query("q") q?: string,
    @Query("minPrice") minPrice?: string,
    @Query("maxPrice") maxPrice?: string,
  ) {
    return this.shoesService.findAll({
      brandId: brandId ? Number(brandId) : undefined,
      category: category?.trim() || undefined,
      q: q?.trim() || undefined,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
    });
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.shoesService.findOne(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateShoeDto) {
    return this.shoesService.create(dto);
  }

  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateShoeDto,
  ) {
    return this.shoesService.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.shoesService.remove(id);
  }
}
