import type { BusinessId, BusinessLocation } from "@tali/domain";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { Page, PageRequest } from "../../queries/pagination.js";

/** Business locations. Every method is scoped by the context business. */
export interface LocationRepository {
  insert(scope: TransactionScope, location: BusinessLocation): Promise<void>;
  /** The business's locations ordered by ID, after the cursor when given. */
  listForBusiness(scope: TransactionScope, businessId: BusinessId, page: PageRequest): Promise<Page<BusinessLocation>>;
}
