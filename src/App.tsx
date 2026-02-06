import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Bar, Line } from "react-chartjs-2";
import "chart.js/auto";

type ParsedRow = {
  patientCode: string;
  userName: string;
  doctorName: string;
  sentDate: Date;
  deliveredDate: Date;
  approvedDate: Date;
  waitingTime: number;
  handlingTime: number;
  totalTat: number;
};

type AgentMetrics = {
  userName: string;
  totalRequests: number;
  averageHandlingTime: number;
  handlingSla: number;
};

type TeamMetrics = {
  averageWaitingTime: number;
  assignmentSla: number;
  peakHours: { hour: number; count: number }[];
};

const REQUIRED_COLUMNS = [
  "كود المريض",
  "اسم المستخدم",
  "اسم الطبيب",
  "تاريخ الإرسال",
  "تاريخ التسليم",
  "تاريخ الموافقة",
] as const;

const arabicDigitMap: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
};

const normalizeDigits = (value: string) =>
  value.replace(/[٠-٩]/g, (digit) => arabicDigitMap[digit] ?? digit);

const parseDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const ms = value * 24 * 60 * 60 * 1000;
    const date = new Date(excelEpoch.getTime() + ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const normalized = normalizeDigits(value.trim());
    if (!normalized) {
      return null;
    }

    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }

    const separators = /[\/\-\.]/;
    if (separators.test(normalized)) {
      const parts = normalized.split(separators).map((part) => part.trim());
      if (parts.length >= 3) {
        const [day, month, year] = parts.map((part) => Number(part));
        const fallback = new Date(year, month - 1, day);
        return Number.isNaN(fallback.getTime()) ? null : fallback;
      }
    }
  }

  return null;
};

const minutesBetween = (start: Date, end: Date) => {
  const diff = (end.getTime() - start.getTime()) / (1000 * 60);
  if (!Number.isFinite(diff) || diff < 0) {
    return null;
  }
  return Math.round(diff);
};

const formatMinutes = (value: number) => `${value.toFixed(1)} دقيقة`;

const formatPercentage = (value: number) => `${value.toFixed(1)}%`;

const App = () => {
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [agents, setAgents] = useState<AgentMetrics[]>([]);
  const [teamMetrics, setTeamMetrics] = useState<TeamMetrics | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setError(null);
    setParsedRows([]);
    setAgents([]);
    setTeamMetrics(null);
    setSkippedCount(0);

    if (!file) {
      setFileName(null);
      return;
    }

    setFileName(file.name);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array", cellDates: true });
      const sheet = workbook.Sheets["ag-grid"];

      if (!sheet) {
        throw new Error("لم يتم العثور على ورقة العمل ag-grid في الملف.");
      }

      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: null,
      });

      if (!rows.length) {
        throw new Error("لا توجد بيانات في ورقة العمل ag-grid.");
      }

      const availableColumns = new Set(Object.keys(rows[0] ?? {}));
      const missingColumns = REQUIRED_COLUMNS.filter(
        (column) => !availableColumns.has(column),
      );

      if (missingColumns.length) {
        throw new Error(
          `الاعمدة التالية غير موجودة: ${missingColumns.join("، ")}.`,
        );
      }

      let skipped = 0;
      const parsed: ParsedRow[] = [];

      rows.forEach((row) => {
        const patientCode = String(row["كود المريض"] ?? "").trim();
        const userName = String(row["اسم المستخدم"] ?? "").trim();
        const doctorName = String(row["اسم الطبيب"] ?? "").trim();
        const sentDate = parseDate(row["تاريخ الإرسال"]);
        const deliveredDate = parseDate(row["تاريخ التسليم"]);
        const approvedDate = parseDate(row["تاريخ الموافقة"]);

        if (
          !patientCode ||
          !userName ||
          !doctorName ||
          !sentDate ||
          !deliveredDate ||
          !approvedDate
        ) {
          skipped += 1;
          return;
        }

        const waitingTime = minutesBetween(sentDate, deliveredDate);
        const handlingTime = minutesBetween(deliveredDate, approvedDate);
        const totalTat = minutesBetween(sentDate, approvedDate);

        if (
          waitingTime === null ||
          handlingTime === null ||
          totalTat === null
        ) {
          skipped += 1;
          return;
        }

        parsed.push({
          patientCode,
          userName,
          doctorName,
          sentDate,
          deliveredDate,
          approvedDate,
          waitingTime,
          handlingTime,
          totalTat,
        });
      });

      if (!parsed.length) {
        throw new Error("لم يتم العثور على صفوف صالحة بعد التحقق من البيانات.");
      }

      const agentMap = new Map<
        string,
        { total: number; handlingSum: number; handlingSlaCount: number }
      >();
      let waitingSum = 0;
      let waitingSlaCount = 0;
      const peakHours = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        count: 0,
      }));

      parsed.forEach((row) => {
        const agent = agentMap.get(row.userName) ?? {
          total: 0,
          handlingSum: 0,
          handlingSlaCount: 0,
        };
        agent.total += 1;
        agent.handlingSum += row.handlingTime;
        if (row.handlingTime <= 20) {
          agent.handlingSlaCount += 1;
        }
        agentMap.set(row.userName, agent);

        waitingSum += row.waitingTime;
        if (row.waitingTime <= 10) {
          waitingSlaCount += 1;
        }

        const hour = row.sentDate.getHours();
        peakHours[hour].count += 1;
      });

      const agentMetrics: AgentMetrics[] = Array.from(agentMap.entries()).map(
        ([userName, data]) => ({
          userName,
          totalRequests: data.total,
          averageHandlingTime: data.handlingSum / data.total,
          handlingSla: (data.handlingSlaCount / data.total) * 100,
        }),
      );

      agentMetrics.sort((a, b) => b.totalRequests - a.totalRequests);

      const topHours = [...peakHours]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .filter((item) => item.count > 0);

      const teamStats: TeamMetrics = {
        averageWaitingTime: waitingSum / parsed.length,
        assignmentSla: (waitingSlaCount / parsed.length) * 100,
        peakHours: topHours,
      };

      setParsedRows(parsed);
      setAgents(agentMetrics);
      setTeamMetrics(teamStats);
      setSkippedCount(skipped);
    } catch (fileError) {
      if (fileError instanceof Error) {
        setError(fileError.message);
      } else {
        setError("حدث خطأ غير متوقع أثناء معالجة الملف.");
      }
    }
  };

  const barData = useMemo(() => {
    return {
      labels: agents.map((agent) => agent.userName),
      datasets: [
        {
          label: "إجمالي الطلبات",
          data: agents.map((agent) => agent.totalRequests),
          backgroundColor: "rgba(59, 130, 246, 0.7)",
        },
      ],
    };
  }, [agents]);

  const handlingData = useMemo(() => {
    return {
      labels: agents.map((agent) => agent.userName),
      datasets: [
        {
          label: "متوسط وقت المعالجة (دقيقة)",
          data: agents.map((agent) => agent.averageHandlingTime),
          backgroundColor: "rgba(16, 185, 129, 0.7)",
        },
      ],
    };
  }, [agents]);

  const peakData = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    const counts = hours.map(
      (hour) =>
        parsedRows.filter((row) => row.sentDate.getHours() === hour).length,
    );
    return {
      labels: hours.map((hour) => `${hour}:00`),
      datasets: [
        {
          label: "الارسال حسب الساعة",
          data: counts,
          borderColor: "rgba(99, 102, 241, 0.8)",
          backgroundColor: "rgba(99, 102, 241, 0.2)",
          fill: true,
          tension: 0.3,
        },
      ],
    };
  }, [parsedRows]);

  const hasData = parsedRows.length > 0 && teamMetrics;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">لوحة متابعة زمن الإنجاز</h1>
            <p className="text-sm text-slate-500">
              حمّل ملف Excel للحصول على ملخص سريع للوقت والتوافق مع SLA.
            </p>
          </div>
          <div className="text-sm text-slate-500">
            {fileName ? `الملف الحالي: ${fileName}` : "لم يتم رفع ملف بعد"}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <section className="card">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">تحميل ملف البيانات</h2>
              <p className="text-sm text-slate-500">
                يجب أن يحتوي الملف على ورقة باسم ag-grid وبالعناوين العربية
                المطلوبة.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500">
                اختيار ملف
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </label>
            </div>
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              {error}
            </div>
          )}
          {hasData && skippedCount > 0 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-600">
              تم تجاهل {skippedCount} صف بسبب بيانات ناقصة أو تواريخ غير صالحة.
            </div>
          )}
        </section>

        {hasData && teamMetrics && (
          <section className="grid gap-4 md:grid-cols-3">
            <div className="card">
              <div className="metric-label">متوسط وقت الانتظار</div>
              <div className="metric-value">
                {formatMinutes(teamMetrics.averageWaitingTime)}
              </div>
            </div>
            <div className="card">
              <div className="metric-label">نسبة الالتزام بتعيين الطلبات</div>
              <div className="metric-value">
                {formatPercentage(teamMetrics.assignmentSla)}
              </div>
            </div>
            <div className="card">
              <div className="metric-label">أوقات الذروة</div>
              <div className="text-sm text-slate-700">
                {teamMetrics.peakHours.length
                  ? teamMetrics.peakHours
                      .map(
                        (item) =>
                          `${item.hour}:00 (${item.count} طلب)`,
                      )
                      .join("، ")
                  : "لا توجد بيانات كافية"}
              </div>
            </div>
          </section>
        )}

        {hasData && (
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="card">
              <h3 className="mb-4 text-base font-semibold">
                إجمالي الطلبات لكل موظف
              </h3>
              <Bar data={barData} />
            </div>
            <div className="card">
              <h3 className="mb-4 text-base font-semibold">
                متوسط وقت المعالجة لكل موظف
              </h3>
              <Bar data={handlingData} />
            </div>
            <div className="card lg:col-span-2">
              <h3 className="mb-4 text-base font-semibold">
                توزيع الإرسال حسب الساعات
              </h3>
              <Line data={peakData} />
            </div>
          </section>
        )}

        {hasData && (
          <section className="card">
            <h3 className="text-base font-semibold">أداء الموظفين</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-right font-medium">
                      اسم المستخدم
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      إجمالي الطلبات
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      متوسط وقت المعالجة (دقيقة)
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      نسبة الالتزام بالمعالجة
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {agents.map((agent) => (
                    <tr key={agent.userName}>
                      <td className="px-4 py-2">{agent.userName}</td>
                      <td className="px-4 py-2">{agent.totalRequests}</td>
                      <td className="px-4 py-2">
                        {agent.averageHandlingTime.toFixed(1)}
                      </td>
                      <td className="px-4 py-2">
                        {formatPercentage(agent.handlingSla)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {!hasData && (
          <section className="card text-sm text-slate-500">
            ارفع ملف Excel لعرض البيانات والرسوم البيانية.
          </section>
        )}
      </main>
    </div>
  );
};

export default App;
