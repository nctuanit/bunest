import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from "@bunest/core";
import { CreateBrandDto } from "./brand.dto";
import { BrandsService } from "./brands.service";

@Controller("brands")
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get()
  findAll() {
    return this.brandsService.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.brandsService.findOne(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateBrandDto) {
    return this.brandsService.create(dto);
  }
}
