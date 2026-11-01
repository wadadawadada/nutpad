/* Smooth vector ostrich (Nostr's mascot), drawn for this app. It is NOT the official artwork. */
export function NostrIcon({ size = 18 }: { size?: number }) {
  return (
    <svg className="nostr-ico" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {/* tail feathers + body */}
      <path d="M2.2 14.2c.9-1.6 2.2-2.2 3.6-1.9.6-1.4 1.9-2.3 3.6-2.3 3.2 0 5.1 2.2 5.1 5 0 2.8-2.3 4.8-5.3 4.8-2.7 0-4.4-1.3-5.2-2.9-.9.1-1.7-.2-2.4-.9-.5-.6-.5-1.3.6-1.8z" fill="currentColor" />
      {/* neck */}
      <path d="M12.2 12.6c3.4-1.9-.2-4.6 2.3-7.2" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
      {/* head + beak */}
      <circle cx="15.3" cy="4.6" r="2.5" fill="currentColor" />
      <path d="M17.3 3.9l4.4 1.1-4.3 1.5z" fill="currentColor" />
      {/* eye */}
      <circle cx="15.6" cy="4.2" r="0.75" fill="var(--eye, #0d0b26)" />
      {/* legs */}
      <path d="M8.6 19.6v3M12 19.6v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
