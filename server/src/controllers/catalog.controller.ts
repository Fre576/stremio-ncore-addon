import type { Context } from 'hono';
import type { CatalogService } from '@/services/catalog';

export class CatalogController {
  constructor(private catalogService: CatalogService) {}

  public async getCatalog(c: Context) {
    const { type, catalogId, extra } = c.req.param();
    return c.json(await this.catalogService.getCatalogMetas({ type, catalogId, extra }));
  }

  public async getMeta(c: Context) {
    const { type, imdbId } = c.req.param();
    return c.json(await this.catalogService.getMeta({ type, imdbId }));
  }
}
