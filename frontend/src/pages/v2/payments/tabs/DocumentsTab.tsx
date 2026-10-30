import { useEffect, useState } from 'react';
import { ConnectComponentsProvider, ConnectDocuments } from '@stripe/react-connect-js';

import { discardViewerConnect, getViewerConnect, onSessionRequestFailed, onSessionRequestSucceeded } from '@/lib/payments/payout-connect';

import { LoadError } from '../../_shared/loadError';
import type { PaymentsTabProps } from '../types';

/**
 * The Documents tab (payments go-live P8): tax forms and statements, shown by the processor's embedded Documents
 * component inside ServWave's tab frame. ServWave keeps no copy of these documents, so there is no table of our own.
 * The period picker does not filter it.
 *
 * It runs on the VIEWER session (the server enables exactly that set and checks "View payments and payouts"). A refused
 * or failed session request ends in the same retry state as a component that reports a load error, because the library
 * may mount nothing at all and never call the component's own hook.
 */
export default function DocumentsTab(_props: PaymentsTabProps) {
  const [loadFailures, setLoadFailures] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () => onSessionRequestFailed((surface) => { if (surface === 'viewer') setLoadFailures((n) => n + 1); }),
    [],
  );
  // The retry state shows only while the section is failed: a session that now answers clears it.
  useEffect(
    () => onSessionRequestSucceeded((surface) => { if (surface === 'viewer') setLoadFailures(0); }),
    [],
  );

  const retry = () => {
    discardViewerConnect();
    setLoadFailures(0);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-4 pt-4">
      <ConnectComponentsProvider key={attempt} connectInstance={getViewerConnect()}>
        <ConnectDocuments onLoadError={() => setLoadFailures((n) => n + 1)} />
      </ConnectComponentsProvider>
      {loadFailures > 0 && <LoadError title="Couldn’t load documents." onRetry={retry} />}
    </div>
  );
}
