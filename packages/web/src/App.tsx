import { Route, Routes } from 'react-router';
import { FastLoginListener } from './components/FastLogin';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { ActionsPage } from './pages/ActionsPage';
import { AnalogousPage } from './pages/AnalogousPage';
import { ConceptsPage } from './pages/ConceptsPage';
import { ForecastPage } from './pages/ForecastPage';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import { ItemsPage } from './pages/ItemsPage';
import { LocationsPage } from './pages/LocationsPage';
import { LoginPage } from './pages/LoginPage';
import { LogPage } from './pages/LogPage';
import { LotsPage } from './pages/LotsPage';
import { PoolsPage } from './pages/PoolsPage';
import { RequestsPage } from './pages/RequestsPage';
import { TrashPage } from './pages/TrashPage';
import { TypesPage } from './pages/TypesPage';
import { UsersPage } from './pages/UsersPage';
import { VariantsPage } from './pages/VariantsPage';
import { useI18n } from './i18n';

function NotFound() {
  const { t } = useI18n();
  return <p className="text-muted">{t('common.notFound')}</p>;
}

export function App() {
  return (
    <>
      {/* Outside the routes on purpose: a key chord signs you in from the
          login screen and switches user from anywhere else. */}
      <FastLoginListener />
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="items" element={<ItemsPage />} />
        <Route path="concepts" element={<ConceptsPage />} />
        <Route path="analogous" element={<AnalogousPage />} />
        <Route path="variants" element={<VariantsPage />} />
        <Route path="locations" element={<LocationsPage />} />
        <Route path="types" element={<TypesPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="trash" element={<TrashPage />} />
        {/* */}
        <Route path="requests" element={<RequestsPage />} />
        <Route path="lots" element={<LotsPage />} />
        <Route path="forecast" element={<ForecastPage />} />
        <Route path="actions" element={<ActionsPage />} />
        <Route path="pools" element={<PoolsPage />} />
        <Route path="log" element={<LogPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </>
  );
}
