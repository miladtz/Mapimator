export interface Country { id: string; name: string; nameFa?: string; label: [number, number]; path: string; }

export const PERSIAN_COUNTRY_NAMES: Record<string, string> = {
  canada: 'کانادا', usa: 'ایالات متحده', mexico: 'مکزیک', brazil: 'برزیل', uk: 'بریتانیا', france: 'فرانسه', germany: 'آلمان', russia: 'روسیه', turkey: 'ترکیه', iran: 'ایران', iraq: 'عراق', saudi: 'عربستان سعودی', india: 'هند', china: 'چین', japan: 'ژاپن', egypt: 'مصر', nigeria: 'نیجریه', 'south-africa': 'آفریقای جنوبی', australia: 'استرالیا'
};

// Small bundled starter dataset. Production data packages replace this with versioned Natural Earth geometry.
export const COUNTRIES: Country[] = [
  { id: 'canada', name: 'CANADA', label: [245, 155], path: 'M72 105 L166 70 L275 83 L362 113 L352 165 L269 177 L200 156 L136 173 L75 151 Z' },
  { id: 'usa', name: 'UNITED STATES', label: [252, 222], path: 'M116 184 L196 174 L257 183 L340 178 L368 216 L336 251 L287 250 L253 274 L185 250 L127 236 Z' },
  { id: 'mexico', name: 'MEXICO', label: [271, 278], path: 'M254 259 L310 254 L336 277 L315 310 L281 323 L255 295 Z' },
  { id: 'brazil', name: 'BRAZIL', label: [449, 361], path: 'M408 282 L473 267 L522 300 L527 362 L490 421 L436 405 L405 345 Z' },
  { id: 'uk', name: 'UNITED KINGDOM', label: [481, 184], path: 'M464 153 L480 147 L493 163 L486 184 L471 180 Z' },
  { id: 'france', name: 'FRANCE', label: [503, 219], path: 'M484 195 L520 191 L537 219 L516 244 L486 229 Z' },
  { id: 'germany', name: 'GERMANY', label: [546, 203], path: 'M531 179 L559 177 L571 207 L553 229 L531 213 Z' },
  { id: 'russia', name: 'RUSSIA', label: [696, 159], path: 'M565 124 L666 92 L796 105 L919 137 L911 187 L820 191 L758 173 L677 189 L596 172 Z' },
  { id: 'turkey', name: 'TURKEY', label: [593, 259], path: 'M548 246 L649 247 L658 268 L557 273 Z' },
  { id: 'iran', name: 'IRAN', label: [650, 292], path: 'M623 266 L674 260 L705 285 L687 327 L645 324 L618 299 Z' },
  { id: 'iraq', name: 'IRAQ', label: [604, 292], path: 'M586 268 L620 267 L622 307 L602 317 L582 294 Z' },
  { id: 'saudi', name: 'SAUDI ARABIA', label: [622, 349], path: 'M573 320 L660 319 L691 362 L650 398 L586 381 Z' },
  { id: 'india', name: 'INDIA', label: [752, 326], path: 'M722 282 L760 280 L782 327 L759 385 L725 347 Z' },
  { id: 'china', name: 'CHINA', label: [795, 255], path: 'M739 202 L824 193 L874 237 L853 293 L786 301 L748 270 Z' },
  { id: 'japan', name: 'JAPAN', label: [901, 247], path: 'M897 211 L911 217 L918 266 L904 282 L890 256 Z' },
  { id: 'egypt', name: 'EGYPT', label: [557, 327], path: 'M530 305 L568 304 L574 340 L546 343 Z' },
  { id: 'nigeria', name: 'NIGERIA', label: [506, 380], path: 'M480 354 L525 350 L539 383 L516 409 L480 394 Z' },
  { id: 'south-africa', name: 'SOUTH AFRICA', label: [550, 481], path: 'M514 452 L568 445 L592 478 L557 505 L523 490 Z' },
  { id: 'australia', name: 'AUSTRALIA', label: [844, 448], path: 'M782 413 L867 405 L910 439 L884 488 L807 487 L774 454 Z' }
];
