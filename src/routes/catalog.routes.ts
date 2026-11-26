import { Router } from "express";
import { adaptHandler } from "../middlewares/adapter";
import {
  getCatalog,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
} from "../handlers/catalog";

const router = Router();

router.get("/", adaptHandler(getCatalog));
router.post("/", adaptHandler(createCatalogItem));
router.put("/:id", adaptHandler(updateCatalogItem));
router.delete("/:id", adaptHandler(deleteCatalogItem));

export default router;
