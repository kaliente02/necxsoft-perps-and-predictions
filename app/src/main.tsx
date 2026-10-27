import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClientProvider } from '@solana/react';
import { client } from './client';
import { TxProvider } from './tx';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClientProvider client={client}>
      <TxProvider>
        <App />
      </TxProvider>
    </ClientProvider>
  </React.StrictMode>,
);
