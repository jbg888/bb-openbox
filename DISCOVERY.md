# Best Buy Open-Box scraper — endpoint discovery (2026-09-01)

All verified from Jonathan's Chrome on bestbuy.com. Everything below is plain HTTP/JSON; no UI clicking required.

## 1. Listing pages (which SKUs are open-box, in stock, ≥$250, pickup at the 11 stores)
GET https://www.bestbuy.com/site/searchpage.jsp?browsedCategory=pcmcat748300666861&id=pcat17071&qp=<QP>&st=pcmcat748300666861_categoryid%24cat00000&cp=<PAGE>

QP = '^'-joined, URL-encoded:
  storepickupstores_facet=Store Availability - In Store Pickup~<STORE>   (one per store: 183,137,179,109,1510,764,9149,1537,104,1511,393)
  category_facet=<CATEGORY>
  currentprice_facet=Price~250 to Up
  soldout_facet=Availability~Exclude Out of Stock Items

Categories (facet value):
  Cameras, Camcorders & Drones~abcat0400000        (4 pages)
  Computers & Tablets~abcat0500000                 (13 pages)
  Headphones~abcat0204000                          (1 page)
  Health, Wellness & Personal Care~pcmcat242800050021 (1 page)
  Home Audio & Speakers~abcat0200000               (8 pages)
  Home, Furniture & Office~pcmcat312300050015      (0-1 pages)
  Smart Home~pcmcat254000050002                    (1 page)
  TV & Home Theater~abcat0100000                   (6 pages)

- Server-rendered HTML (~2.5 MB/page), 18 products/page. Extract SKUs with regex: data-product-id="(\d+)"
- Last page number: max of cp=N in pagination links.
- Fetching 8 pages in parallel from a browser context took ~2.6 s.
- Category = the listing it came from (a SKU can appear in more than one; dedupe by SKU, keep first category).

## 2. Prices per condition (regular/"Comp. Value", new price, open-box price for Fair/Good/Excellent)
POST https://www.bestbuy.com/gateway/graphql   (content-type: application/json; works with NO cookies and no special headers)
The gateway accepts arbitrary queries with aliases -> batch many SKUs x conditions in one request.

query q {
  s6670835_c0: productBySkuId(skuId:"6670835", openBoxCondition:0) {
    skuId openBoxCondition name { short }
    buyingOptions { type pdpUrl }
    price(input:{salesChannel:"LargeView", usePriceWithCart:true, useCabo:true, useSuco:true}) {
      regularPrice customerPrice openBoxPrice openBoxCondition totalSavings totalSavingsPercent preferredBadging
    }
  }
  s6670835_new: productBySkuId(skuId:"6670835") { skuId price(input:{...same...}) { regularPrice customerPrice } }
}

openBoxCondition: 0 = Fair, 1 = Good, 2 = Excellent (omit for New). (A 4th tier "Certified Excellent" exists in fulfillment data; not seen priced.)
- regularPrice == the "Comp. Value" shown in the More Buying Options panel.
- customerPrice on the New query == current New selling price.
- openBoxPrice == price for that condition (returned even if not in stock nearby; stock comes from #3).
- buyingOptions[].pdpUrl gives the deep link, e.g. .../sku/6670835/openbox?condition=good
Example: SKU 6670829 (Samsung 55" U8000H): regular 379.99, new 299.99, fair 261.99.

## 3. Store availability per condition (which of the 11 stores has the unit in hand)
GET https://www.bestbuy.com/gateway/graphql/fulfillment?variables=<URL-encoded JSON>   (works with no cookies)
{"fulfillmentOptionsInput":{"sku":"6670829","condition":"ANY",
  "shipping":{"destinationZipCode":"90069"},
  "inStorePickup":{"storeId":"393","searchNearby":true,"showNearbyLocations":true}}}

Response (~22 KB): data.fulfillmentOptions.ispuDetails[0]
  .store {storeId,name,city}  + .ispuAvailability[]   -> "my store" (393 West Hollywood)
  .nearbyLocations[] {distance, store{storeId,name,city}, availability[]}   -> 26 other stores within ~108 mi
  availability item: {condition: NEW|OPEN_BOX_FAIR|OPEN_BOX_GOOD|OPEN_BOX_EXCELLENT|OPEN_BOX_CERTIFIED_EXCELLENT,
                      quantity (string, present only when unit is physically there), pickupEligible, instoreInventoryAvailable,
                      fulfillmentType:"PICKUP", displayDateType:"IN_HAND", minPickupInHours}
IN-HAND RULE: treat a (store, condition) as available only if `quantity` is present (pickupEligible alone is true for ship-to-store).
Filter nearbyLocations + my-store to the 11 store IDs.

Store IDs: 393 West Hollywood, 183 Atwater Village, 137 Burbank, 179 Culver City, 109 West LA, 1510 Culver City Westfield,
764 Sherman Oaks, 9149 Compton Warehouse, 1537 Montebello, 104 Hawthorne, 1511 Pacoima.

## 4. What the UI panel actually calls (for reference only; not needed)
MPX_MoreBuyingOptionsData (bsin, skuId, locationId, postalCode) -> 100 KB, no prices.
getProduct (skuId, openBoxCondition) -> the price fragment above.
AddToCart_FulfillmentDynamicQuery / FulfillmentSelector_FulfillmentDynamicQuery -> same price + fulfillment.

## 5. Sizing
~35 listing pages, roughly 400-600 SKUs total. Prices: ~30 batched GraphQL POSTs. Availability: one GET per SKU.
Estimated full run: 2-4 minutes with modest concurrency. Zero LLM tokens at runtime.

## 6. Bot protection notes
Akamai + reCAPTCHA Enterprise are present on the site. All calls above succeeded from a real Chrome profile.
Run the scraper through Playwright driving installed Chrome (channel "chrome", persistent profile) and issue fetches
from the page context so they inherit browser fingerprint/cookies. Datacenter IPs are likely to be blocked.
