"use client";

import * as React from "react";
import { Download, Plus } from "lucide-react";

import {
  Breadcrumbs, BreadcrumbItem, BreadcrumbLink, BreadcrumbList,
  BreadcrumbPage, BreadcrumbSeparator,
} from "@/ui-kit/components/layout/nav/breadcrumbs";
import { PageHeader } from "@/ui-kit/components/layout/pageHeader";

import { Button } from "@/ui-kit/components/ui/button";

import { DataTable } from "@/ui-kit/components/data/dataTable/dataTable";
import { DataTableToolbar } from "@/ui-kit/components/data/dataTable/dataTableToolbar";
import { StatCard, StatCardGroup } from "@/ui-kit/components/data/statCard";
import { EmptyState } from "@/ui-kit/components/data/emptyState";
import { FilterBar, type ActiveFilter } from "@/ui-kit/components/crm/filterBar";
import { BulkActionBar } from "@/ui-kit/components/crm/bulkActionBar";

import { jobsColumns } from "./jobsColumns";
import { jobMetrics, jobs, type JobStatus } from "./jobsData";

/**
 * Jobs - the list view.
 *
 * Rebuilt from the ServWave demo in this design system. Three deliberate
 * departures from the original, each because a component here does the job
 * better than the markup it replaces:
 *
 * 1. Customer and Location were separate columns. Merged into a two-line cell,
 *    which halves the horizontal scroll and puts the two facts that identify a
 *    job - who and where - inside one glance.
 * 2. "Assigned to" was plain text, including the word "Unassigned" repeated
 *    down the column. Now an avatar, so assignment reads as a state rather than
 *    as more text to parse.
 * 3. The metric tiles are now filters. They already showed counts per status;
 *    making them pressable removes a trip through the filter menu for the most
 *    common narrowing anyone does on this page.
 *
 * PAGE CONTENT ONLY. The shell (topbar, sidebar, canvas) is supplied by the
 * route's layout, so this renders straight into the canvas body. It used to
 * mount its own AppShell with a hardcoded nav, which would nest a second shell
 * inside the real one.
 */
export default function JobsPage() {
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<JobStatus | null>(null);

  const rows = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return jobs.filter((job) => {
      if (statusFilter && job.status !== statusFilter) return false;
      if (!query) return true;
      return `${job.number} ${job.customer} ${job.location}`.toLowerCase().includes(query);
    });
  }, [search, statusFilter]);

  const activeFilters: ActiveFilter[] = [
    ...(statusFilter ? [{ id: "status", label: "Status", value: statusFilter }] : []),
    ...(search ? [{ id: "search", label: "Search", value: search }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs>
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink href="/">Home</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbLink href="/">Operations</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>Jobs</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumbs>
        }
        title="Jobs"
        description="Every job across your crews, live."
        actions={
          <>
            <Button variant="outline"><Download />Export</Button>
            <Button><Plus />New job</Button>
          </>
        }
      />

      <StatCardGroup className="mb-4 xl:grid-cols-6">
        {jobMetrics.map((metric) => {
          const isStatus = metric.key !== "needInvoices";
          const active = statusFilter === metric.key;
          return (
            <StatCard
              key={metric.key}
              label={metric.label}
              value={metric.value}
              active={active}
              onClick={
                isStatus
                  ? () => setStatusFilter(active ? null : (metric.key as JobStatus))
                  : undefined
              }
            />
          );
        })}
      </StatCardGroup>

      <FilterBar
        className="mb-3"
        filters={activeFilters}
        resultCount={rows.length}
        totalCount={jobs.length}
        onRemove={(id) => (id === "status" ? setStatusFilter(null) : setSearch(""))}
        onClearAll={() => { setStatusFilter(null); setSearch(""); }}
      />

      <DataTable
        columns={jobsColumns}
        data={rows}
        getRowId={(job) => job.id}
        initialPageSize={25}
        empty={
          <EmptyState
            title="No jobs match those filters"
            description="Try a different search term, or clear the status filter."
            action={
              <Button variant="outline" onClick={() => { setSearch(""); setStatusFilter(null); }}>
                Clear filters
              </Button>
            }
          />
        }
      >
        {(table) => (
          <>
            <DataTableToolbar
              table={table}
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder="Search jobs, customers, addresses…"
            />
            <BulkActionBar
              count={table.getFilteredSelectedRowModel().rows.length}
              noun={["job", "jobs"]}
              onClear={() => table.resetRowSelection()}
            >
              <Button variant="secondary" size="sm">Assign technician</Button>
              <Button variant="outline" size="sm">Reschedule</Button>
              <Button variant="outline" size="sm">Export</Button>
            </BulkActionBar>
          </>
        )}
      </DataTable>
    </>
  );
}
